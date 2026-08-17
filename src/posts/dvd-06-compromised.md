---
title: "[DVD-06] Compromised: hai private key của oracle source bị lộ, thao túng median price để mua rẻ bán đắt"
description: "TrustfulOracle lấy median giá từ 3 trusted source; hai trong số đó bị lộ private key qua một chuỗi hex → ASCII → base64. Với 2/3 số phiếu, attacker hoàn toàn kiểm soát median: hạ giá DVNFT về 0 để mua NFT gần như miễn phí, đẩy giá lên bằng đúng số dư exchange để bán lại rút sạch 999 ETH, rồi khôi phục giá ban đầu."
pubDate: 2026-08-22
tags: ["web3", "ctf", "smart-contract", "damn-vulnerable-defi", "oracle-manipulation", "private-key-leak"]
draft: false
challenge: "damn-vulnerable-defi"
difficulty: "easy"
series: "damn-vulnerable-defi"
---

## Tóm tắt

Compromised xoay quanh một oracle giá tập trung: **TrustfulOracle** tính median giá từ đúng 3 trusted source. Nhiệm vụ phụ của challenge là phát hiện hai private key bị rò rỉ trong tài liệu (hex string → ASCII → base64 → private key), khớp với 2 trong 3 source. Vì median của 3 giá trị chỉ cần 2 phiếu để quyết định, attacker thao túng giá DVNFT theo ý muốn: hạ về 0 để mua NFT của exchange với giá gần như không, đẩy lên đúng bằng số dư exchange để bán lại rút sạch 999 ETH, rồi đưa giá về mức cũ — mọi assert của challenge vẫn khớp.

## Bối cảnh & Mục tiêu

Các contract liên quan:

- **TrustfulOracle** (`src/compromised/TrustfulOracle.sol`) — mỗi source có vai trò `TRUSTED_SOURCE_ROLE` và tự `postPrice()` (dòng 55–57). `getMedianPrice()` (dòng 59–61) sắp xếp giá của tất cả source rồi lấy phần tử giữa (`_computeMedianPrice`, dòng 85–95).
- **Exchange** (`src/compromised/Exchange.sol`) — `buyOne()` (dòng 30–47) mint NFT với giá bằng `oracle.getMedianPrice("DVNFT")`, hoàn lại phần tiền dư; `sellOne()` (dòng 49–70) đốt NFT và trả cho người bán đúng giá oracle từ số dư của exchange.
- **TrustfulOracleInitializer** (`src/compromised/TrustfulOracleInitializer.sol`) — deploy oracle với 3 source và giá khởi điểm.

Trạng thái ban đầu (`test/compromised/Compromised.t.sol`): 3 source `0x188E…3088`, `0xA417…9D8`, `0xab36…a40` đều báo DVNFT = 999 ether; exchange giữ 999 ETH; player chỉ có 0.1 ETH.

Điều kiện thắng (`_isSolved()`): exchange hết ETH (0); recovery nhận đủ 999 ETH; player không sở hữu NFT nào; và median giá DVNFT quay về đúng 999 ether.

## Phân tích lỗ hổng

### 1. Median của 3 source, kiểm soát được bởi 2

Với 3 giá trị, median là phần tử giữa sau khi sắp xếp. Nếu 2 source cùng báo một giá trị X, median luôn là X bất kể source thứ ba báo gì:

- Cả 3 báo 0 → median 0.
- Hai source báo 0, một source báo 999 → dãy `[0, 0, 999]` → median 0.
- Hai source báo 999, một source báo 0 → dãy `[0, 999, 999]` → median 999.

Nghĩa là 2/3 source bị kiểm soát là đủ để định đoạt toàn bộ giá. Oracle không có cơ chế nào phát hiện giá bất thường hay chênh lệch lớn giữa các source.

### 2. Private key bị rò rỉ qua chuỗi mã hóa yếu

Phần "compromised" của challenge: tài liệu rò rỉ chứa hai hex string. Giải mã theo chiều ngược:

1. Hex string → bytes → **ASCII text**, vốn là một chuỗi **base64**;
2. Base64 decode → **private key** (32 bytes).

Hai private key thu được khớp chính xác với `sources[0]` và `sources[1]` (kiểm tra bằng `vm.addr(pk)` trong test). Với private key, attacker ký lệnh `postPrice()` hợp lệ với vai trò `TRUSTED_SOURCE_ROLE` — không cần phá bất kỳ cơ chế on-chain nào.

## Khai thác

Kịch bản 3 bước, tất cả đều là giao dịch hợp lệ:

1. **Hạ giá mua:** hai source bị chiếm gọi `oracle.postPrice("DVNFT", 0)` → median = 0. Player gọi `exchange.buyOne{value: 1}()` — `msg.value (1) >= price (0)`, exchange mint NFT và hoàn lại 1 wei. Player sở hữu NFT với chi phí ~0, số dư exchange không đổi (999 ether).

2. **Đẩy giá bán:** hai source gọi `postPrice("DVNFT", 999e18)` — chọn đúng bằng số dư hiện tại của exchange để `sellOne` không vượt quá `address(this).balance` (dòng 60–62). Median quay về 999 ether.

3. **Bán và chốt lời:** player approve NFT cho exchange, gọi `sellOne(id)` — exchange đốt NFT và trả 999 ETH. Player chuyển toàn bộ về `recovery`. Median cuối cùng vẫn là 999 ether nên assert giá không đổi vẫn pass.

```solidity
// 2/3 trusted source đủ để quyết định median -> hạ giá về 0 để mua gần như free.
vm.prank(sources[0]); oracle.postPrice("DVNFT", 0);
vm.prank(sources[1]); oracle.postPrice("DVNFT", 0);

vm.prank(player);
uint256 id = exchange.buyOne{value: 1}();

// Đặt giá = balance hiện tại của exchange (999 ether) -> vừa khớp
// INITIAL_NFT_PRICE cho assertion cuối, vừa đủ để sellOne rút sạch.
uint256 price = address(exchange).balance;
vm.prank(sources[0]); oracle.postPrice("DVNFT", price);
vm.prank(sources[1]); oracle.postPrice("DVNFT", price);

vm.startPrank(player);
nft.approve(address(exchange), id);
exchange.sellOne(id);
payable(recovery).transfer(price);
vm.stopPrank();
```

## Kết quả

Chạy `forge test --match-contract CompromisedChallenge -vv`:

```
Ran 2 tests for test/compromised/Compromised.t.sol:CompromisedChallenge
[PASS] test_assertInitialState() (gas: 40706)
[PASS] test_compromised() (gas: 238641)
Suite result: ok. 2 passed; 0 failed; 0 skipped
```

## Bài học & Cách phòng tránh

- **Không để một nhóm nhỏ source quyết định giá tài sản.** Với median của 3 source, chỉ cần 2 source thỏa hiệp là giá bị kiểm soát hoàn toàn. Cần số source lớn hơn, ngưỡng đa số cao hơn (ví dụ yêu cầu đa số tuyệt đối trong tập lớn), hoặc dùng oracle phi tập trung chuyên dụng như Chainlink.
- **Phát hiện giá bất thường:** theo dõi độ lệch giữa các source và so với giá tham chiếu (deviation check, circuit breaker) để chặn các cú sốc giá trong một block.
- **Bảo vệ khóa offline:** private key của oracle source là điểm tấn công off-chain quan trọng nhất — cần HSM, multisig, luân chuyển khóa, và tuyệt đối không để khóa xuất hiện dưới dạng dữ liệu có thể giải mã ngược (hex/base64) trong tài liệu nội bộ.
- **Không để exchange phụ thuộc hoàn toàn vào một oracle có thể bị thao túng** khi số tiền liên quan lớn hơn nhiều lần chi phí thao túng.

## Tham khảo

- Challenge: [Compromised — Damn Vulnerable DeFi](https://www.damnvulnerabledefi.xyz/)
- Source: `src/compromised/TrustfulOracle.sol`, `src/compromised/Exchange.sol`, `src/compromised/TrustfulOracleInitializer.sol`, `test/compromised/Compromised.t.sol`
