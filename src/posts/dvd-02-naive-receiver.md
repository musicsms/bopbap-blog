---
title: "[DVD-02] Naive Receiver: forced flash loan rút phí victim và mạo danh fee receiver qua trusted forwarder"
description: "NaiveReceiverPool không kiểm tra initiator của flash loan, cho phép bất kỳ ai bắt FlashLoanReceiver trả phí cố định 1 WETH mỗi lần. Sau khi receiver cạn tiền, lỗ hổng _msgSender() của trusted forwarder kết hợp multicall giúp player mạo danh deployer để rút toàn bộ pool trong đúng 2 giao dịch."
pubDate: 2026-08-18
tags: ["web3", "ctf", "smart-contract", "damn-vulnerable-defi", "flash-loan", "meta-transaction"]
draft: false
challenge: "damn-vulnerable-defi"
difficulty: "easy"
series: "damn-vulnerable-defi"
---

## Tóm tắt

Challenge yêu cầu rút sạch cả pool lẫn contract receiver chỉ trong **tối đa 2 giao dịch**. Pool cho flash loan với phí cố định 1 WETH nhưng không kiểm tra ai là người khởi tạo khoản vay — player lợi dụng để "bắt" receiver (nạn nhân) trả phí 10 lần liên tiếp, rút cạn 10 WETH của receiver. Sau đó player dùng chính cơ chế trusted forwarder của pool, nhét địa chỉ deployer vào cuối calldata, để `_msgSender()` trả về deployer và rút toàn bộ 1010 WETH còn lại trong pool về tài khoản recovery.

## Bối cảnh & Mục tiêu

Các contract liên quan:

- **NaiveReceiverPool** (`src/naive-receiver/NaiveReceiverPool.sol`) — flash lender ERC3156 với phí cố định `FIXED_FEE = 1e18` (dòng 12). Pool kế thừa `Multicall` và hỗ trợ meta-transaction qua trusted forwarder.
- **FlashLoanReceiver** (`src/naive-receiver/FlashLoanReceiver.sol`) — contract victim giữ 10 WETH, sẵn sàng nhận flash loan. `onFlashLoan` chỉ kiểm tra `caller == pool`, rồi approve pool đủ `amount + fee` để hoàn trả.
- **BasicForwarder** (`src/naive-receiver/BasicForwarder.sol`) — forwarder EIP712; `execute()` nối `request.from` vào cuối calldata trước khi gọi target (dòng 63).
- **Multicall** (`src/naive-receiver/Multicall.sol`) — `multicall()` delegatecall từng phần tử `data[i]` vào chính pool (dòng 9–15).

Trạng thái ban đầu: pool chứa 1000 WETH (deposit 1000 của deployer trong constructor, `deposits[deployer] = 1000`), receiver chứa 10 WETH, fee receiver là deployer.

Điều kiện thắng (`_isSolved()`, dòng 126–137): player thực hiện ≤ 2 giao dịch; receiver và pool đều hết WETH; recovery nhận đủ 1010 WETH.

## Phân tích lỗ hổng

### 1. Flash loan không kiểm tra initiator

`flashLoan()` (dòng 43–64) chuyển token tới `receiver`, gọi callback, rồi `transferFrom(receiver, amount + fee)`. Không có bất kỳ kiểm tra nào về việc ai gọi `flashLoan()` hay `receiver` có đồng ý vay hay không:

```solidity
function flashLoan(IERC3156FlashBorrower receiver, address token, uint256 amount, bytes calldata data)
    external
    returns (bool)
{
    if (token != address(weth)) revert UnsupportedCurrency();
    // Transfer WETH and handle control to receiver
    weth.transfer(address(receiver), amount);
    totalDeposits -= amount;
    ...
    uint256 amountWithFee = amount + FIXED_FEE;
    weth.transferFrom(address(receiver), address(this), amountWithFee);
    totalDeposits += amountWithFee;
    deposits[feeReceiver] += FIXED_FEE;
```

Với `amount = 0`, pool chuyển 0 token tới receiver nhưng vẫn gọi callback; receiver approve đủ `amount + fee` và pool rút đúng 1 WETH phí. Mỗi lần gọi như vậy, receiver mất 1 WETH còn `deposits[feeReceiver]` tăng 1 WETH. Gọi 10 lần liên tiếp (gói trong một `multicall`) là đủ để rút cạn 10 WETH của receiver.

### 2. `_msgSender()` có thể bị giả mạo qua calldata

Pool dùng trusted forwarder để lấy người gửi thật (dòng 86–92):

```solidity
function _msgSender() internal view override returns (address) {
    if (msg.sender == trustedForwarder && msg.data.length >= 20) {
        return address(bytes20(msg.data[msg.data.length - 20:]));
    } else {
        return super._msgSender();
    }
}
```

Khi được gọi qua forwarder, 20 byte cuối calldata được coi là "người gửi". BasicForwarder đúng ra nối `request.from` (đã xác thực chữ ký EIP712) vào calldata — nhưng điều đó chỉ đúng cho **lời gọi ngoài cùng**. Nếu lời gọi đó là `multicall()`, các delegatecall bên trong dùng chính `data[i]` làm calldata, mà attacker kiểm soát toàn bộ nội dung. `msg.sender` vẫn là forwarder (delegatecall giữ nguyên), còn 20 byte cuối của `data[i]` là do attacker chọn — vậy `_msgSender()` trả về bất kỳ địa chỉ nào attacker muốn, ở đây là `deployer` (fee receiver, người sở hữu `deposits[deployer] = 1010`).

## Khai thác

**Giao dịch 1 — rút cạn receiver:** player gọi `pool.multicall()` với 10 phần tử, mỗi phần tử là `flashLoan(receiver, weth, 0, "")`. Kết quả: receiver mất 10 WETH tiền phí, `deposits[deployer]` tăng lên 1010, pool hiện giữ 1010 WETH.

**Giao dịch 2 — rút sạch pool:** player ký một request EIP712 (chữ ký của chính player, hợp lệ với forwarder) với `data = pool.multicall([withdrawCall])`, trong đó:

```solidity
bytes memory withdrawCall = abi.encodePacked(
    abi.encodeCall(NaiveReceiverPool.withdraw, (totalStolen, payable(recovery))),
    bytes20(deployer)
);
```

Khi forwarder thực thi: `multicall()` delegatecall `withdrawCall`. Trong `withdraw()`, `msg.sender == trustedForwarder` và 20 byte cuối calldata là `deployer`, nên `_msgSender()` trả về deployer. `withdraw(1010, recovery)` trừ `deposits[deployer]` (1010 − 1010 = 0) và chuyển 1010 WETH về recovery. Chữ ký EIP712 không cần của deployer — điểm mấu chốt là forwarder chỉ xác thực request ngoài, còn "người gửi" của lệnh trong lại do attacker tự đặt.

## Kết quả

Chạy `forge test --match-contract NaiveReceiverChallenge -vv`:

```
Ran 2 tests for test/naive-receiver/NaiveReceiver.t.sol:NaiveReceiverChallenge
[PASS] test_assertInitialState() (gas: 34786)
[PASS] test_naiveReceiver() (gas: 399463)
Suite result: ok. 2 passed; 0 failed; 0 skipped
```

## Bài học & Cách phòng tránh

- **Flash loan phải xác thực người khởi tạo.** `flashLoan()` nên chỉ chấp nhận receiver do chính người dùng chỉ định (initiator phải là `msg.sender`) hoặc yêu cầu receiver chủ động gọi vay, tránh kiểu tấn công "forced flash loan" bắt victim trả phí.
- **Không tin 20 byte cuối calldata.** Cơ chế `_msgSender()` kiểu này chỉ an toàn nếu mọi đường gọi đều đi qua forwarder và forwarder là người duy nhất nối `from` đã xác thực vào cuối calldata. Khi có `delegatecall`/`multicall` chèn giữa, chuỗi calldata bị phá vỡ. Nên lưu người gửi vào storage qua `_msgSender()` một lần ở điểm vào duy nhất, hoặc dùng cơ chế context (ví dụ `_msgData` của OpenZeppelin) nhất quán.
- **Kiểm tra phí và số dư trước khi thực hiện effect:** receiver không nên approve vô điều kiện `amount + fee` khi amount do bên ngoài quyết định.

## Tham khảo

- Challenge: [Naive Receiver — Damn Vulnerable DeFi](https://www.damnvulnerabledefi.xyz/)
- Source: `src/naive-receiver/NaiveReceiverPool.sol`, `src/naive-receiver/FlashLoanReceiver.sol`, `src/naive-receiver/BasicForwarder.sol`, `src/naive-receiver/Multicall.sol`, `test/naive-receiver/NaiveReceiver.t.sol`
