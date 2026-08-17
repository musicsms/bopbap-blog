---
title: "[DVD-01] Unstoppable: phá vỡ invariant ERC4626 bằng một khoản donate để khóa vault"
description: "Mục tiêu là làm cho mọi flash loan của UnstoppableVault thất bại để monitor pause vault. Lỗ hổng nằm ở chỗ totalAssets() đọc balanceOf trực tiếp, khiến invariant ERC4626 convertToShares(totalSupply) == totalAssets() bị phá vỡ chỉ bằng một khoản transfer 1 wei."
pubDate: 2026-08-17
tags: ["web3", "ctf", "smart-contract", "damn-vulnerable-defi", "erc4626", "accounting-manipulation"]
draft: false
challenge: "damn-vulnerable-defi"
difficulty: "easy"
series: "damn-vulnerable-defi"
---

## Tóm tắt

Unstoppable là challenge mở đầu của Damn Vulnerable DeFi v4, khai thác một vault ERC4626 kiêm flash lender. Chỉ cần **một giao dịch**: chuyển thẳng 1 wei token vào vault, bỏ qua hàm `deposit()`. Khoản "donate" này làm lệch số dư token thực tế so với số share đang lưu hành, phá vỡ invariant mà `flashLoan()` dùng để kiểm tra, khiến mọi flash loan sau đó revert. Monitor contract phát hiện sự cố, pause vault và trả quyền sở hữu — đúng điều kiện thắng.

## Bối cảnh & Mục tiêu

Hai contract tham gia:

- **UnstoppableVault** (`src/unstoppable/UnstoppableVault.sol`) — vault ERC4626 (`totalSupply` là share, `asset` là DVT) triển khai chuẩn flash loan ERC3156. Phí flash loan là 0 nếu `block.timestamp < end` và số vay nhỏ hơn `maxFlashLoan()` (dòng 61–65). Vault có cơ chế pause và hàm `execute()` chỉ owner dùng khi paused.
- **UnstoppableMonitor** (`src/unstoppable/UnstoppableMonitor.sol`) — contract giám sát, là owner của vault. Hàm `checkFlashLoan()` (dòng 36–53) thử vay flash loan; nếu thất bại, nó emit `FlashLoanStatus(false)`, gọi `vault.setPause(true)` và `vault.transferOwnership(owner)`.

Trạng thái ban đầu (`test/unstoppable/Unstoppable.t.sol`): deployer deposit 1.000.000 DVT vào vault, nhận về 1.000.000 share (tỷ lệ 1:1); player có 10 DVT; monitor vừa chạy một lần `checkFlashLoan(100e18)` thành công.

Điều kiện thắng trong `_isSolved()` (dòng 106–116): lần `checkFlashLoan` tiếp theo phải thất bại, vault bị pause, và ownership chuyển về deployer.

## Phân tích lỗ hổng

`flashLoan()` bắt đầu bằng một invariant check theo chuẩn ERC4626 (dòng 84–85):

```solidity
uint256 balanceBefore = totalAssets();
if (convertToShares(totalSupply) != balanceBefore) revert InvalidBalance(); // enforce ERC4626 requirement
```

Vấn đề nằm ở định nghĩa `totalAssets()` (dòng 71–73):

```solidity
function totalAssets() public view override nonReadReentrant returns (uint256) {
    return asset.balanceOf(address(this));
}
```

`totalAssets()` đọc **số dư token thực tế** của vault, chứ không phải một biến kế toán nội bộ. Bất kỳ ai cũng có thể `token.transfer(vault, x)` mà không cần qua `deposit()`. Khi đó `balanceOf(vault)` tăng nhưng `totalSupply` (share) không đổi.

Với solmate ERC4626, `convertToShares(totalSupply)` = `totalSupply.mulDivDown(totalSupply, totalAssets())`. Ban đầu 1.000.000e18 token ↔ 1.000.000e18 share, invariant đúng. Sau khi donate 1 wei:

- `totalAssets()` = 1.000.000e18 + 1
- `convertToShares(totalSupply)` = (1.000.000e18)² / (1.000.000e18 + 1) = 1.000.000e18 − 1 (làm tròn xuống)

Hai giá trị lệch nhau → `revert InvalidBalance()` ngay trước khi chuyển token. Mọi flash loan từ đó đều chết. Monitor thấy thất bại, tưởng vault hỏng, liền pause vault và trả ownership cho deployer — không hề biết "sự cố" chỉ là một khoản donate 1 wei của kẻ tấn công.

Đây là một biến thể của lớp lỗ hổng **donation/inflation attack** trên ERC4626: invariant được kiểm tra bằng giá trị balance có thể bị thao túng từ bên ngoài, thay vì dùng sổ kế toán do chính contract quản lý.

## Khai thác

Toàn bộ exploit chỉ là một dòng (trong `test_unstoppable()`):

```solidity
token.transfer(address(vault), 1);
```

Kịch bản diễn ra như sau:

1. Player gửi 1 wei DVT thẳng vào vault, không qua `deposit()`.
2. `_isSolved()` giả lập deployer gọi `monitorContract.checkFlashLoan(100e18)`.
3. `vault.flashLoan(...)` revert `InvalidBalance` vì invariant đã vỡ.
4. Monitor bắt được exception, emit `FlashLoanStatus(false)`, pause vault, chuyển ownership về deployer.
5. Assert pass: `vault.paused() == true`, `vault.owner() == deployer`.

## Kết quả

Chạy `forge test --match-contract UnstoppableChallenge -vv`:

```
Ran 2 tests for test/unstoppable/Unstoppable.t.sol:UnstoppableChallenge
[PASS] test_assertInitialState() (gas: 57303)
[PASS] test_unstoppable() (gas: 66791)
Suite result: ok. 2 passed; 0 failed; 0 skipped
```

## Bài học & Cách phòng tránh

- **Không dùng `balanceOf` làm nguồn kế toán.** `totalAssets()` nên được tính từ sổ sách nội bộ (tổng deposit trừ tổng withdraw) hoặc dùng virtual offset như các implementation ERC4626 chống inflation (ví dụ OpenZeppelin dùng `_asset` + `_decimalsOffset`), để token chuyển thẳng vào vault không làm thay đổi giá trị share.
- **Kiểm tra invariant theo hướng an toàn:** nếu bắt buộc dùng balance, invariant check phải chấp nhận `totalAssets() >= convertToShares(totalSupply)` thay vì yêu cầu bằng tuyệt đối.
- **Phân biệt "token bị kẹt" và "sự cố hệ thống":** monitor tự động pause và trao quyền khẩn cấp dựa trên một lần kiểm tra đơn lẻ là thiết kế nguy hiểm — kẻ tấn công có thể giả tạo sự cố để kích hoạt các hành động phản ứng tự động.

## Tham khảo

- Challenge: [Unstoppable — Damn Vulnerable DeFi](https://www.damnvulnerabledefi.xyz/)
- Source: `src/unstoppable/UnstoppableVault.sol`, `src/unstoppable/UnstoppableMonitor.sol`, `test/unstoppable/Unstoppable.t.sol`
