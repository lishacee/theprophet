# Product

## Register

product

## Users

Nhóm bạn / đồng nghiệp chơi chung một pool dự đoán bóng đá (vd World Cup 2026). Chủ yếu dùng trên **điện thoại**, quanh giờ trận đấu — lướt nhanh trước giờ bóng lăn để đặt kèo, rồi mở lại xem bảng xếp hạng và cà khịa nhau. Một admin (chủ pool) quản lý sảnh: import lịch trận, bật/tắt loại kèo, chấm kết quả, mở lại kèo khi trận dời giờ.

Job-to-be-done:
- **Người chơi**: đặt điểm ảo lên các cửa (Thắng/Hòa/Thua, Tài/Xỉu, Chấp, Góc, Thẻ, BTTS, kèo custom) trước kickoff, theo dõi lãi/lỗ và thứ hạng.
- **Admin**: dựng pool, đồng bộ trận/odds, chấm & sửa kết quả sao cho điểm cộng/trừ luôn đúng.

## Product Purpose

Sân chơi dự đoán bóng đá **bằng điểm ảo, không tiền thật**, riêng tư cho hội bạn. Vào pool → nhận điểm khởi đầu → đặt kèo trước giờ trận → hệ thống tự chấm (hoặc admin chấm tay) → cập nhật bảng xếp hạng, badge, streak, và lưu lại theo mùa.

Thành công = mỗi matchday hội bạn đều quay lại đặt kèo và tranh top, tương tác vui vẻ quanh bảng xếp hạng, thao tác đặt kèo nhanh gọn trên điện thoại.

## Brand Personality

Vui nhộn, cạnh tranh, mang tính hội nhóm. Giọng điệu tiếng Việt đời thường, có chút cà khịa — thể hiện qua badge (demonking, onfire, coldstreak, bot…), streak thắng/thua, và bảng xếp hạng công khai. Cảm xúc muốn khơi: hào hứng ngày bóng lăn, ganh đua thân thiện, cảm giác "ăn kèo" đã tay — nhưng **không** kiểu nhà cái tiền thật.

Ba từ: **playful · competitive · social**.

## Anti-references

- **Web cá độ tiền thật (Bet365, 1xBet…)**: không chớp nháy, không nhồi nhét, không dark-pattern thúc cược, không cảm giác sleazy. Đây là trò chơi điểm ảo giữa bạn bè.
- **Landing AI generic**: không eyebrow chữ hoa tracking rộng trên mỗi mục, không gradient text, không template "hero-metric".
- **Dashboard SaaS xám xịt**: không lưới card đều tăm tắp vô hồn, không xám nhạt "cho sang" làm khó đọc.
- **Fintech nghiêm nghị (navy + vàng)**: không quá trang trọng đến mức mất chất vui.

## Design Principles

1. **Điểm là để chơi, không phải tiền** — tuyệt đối không mượn dark-pattern của nhà cái; giữ tinh thần game vui giữa bạn bè.
2. **Matchday-first, mobile-first** — hành động chính (đặt kèo trước kickoff, liếc bảng xếp hạng) phải nhanh và vừa ngón tay; đừng bắt cuộn/nhấn thừa.
3. **Cà khịa là tính năng** — leaderboard, badge, streak làm sự ganh đua hiện rõ và vui; ưu tiên cá tính hơn sự trung tính.
4. **Tin vào con số** — luồng chấm/sửa kèo phải minh bạch và hiển nhiên đúng (cộng/trừ điểm bằng delta, không double-count); người chơi phải thấy kết quả công bằng.
5. **Thân thiện, không vô hồn** — năng lượng sân cỏ (Neon Pitch), không bao giờ là template xám.

## Accessibility & Inclusion

- Mục tiêu **WCAG AA**: body text contrast ≥ 4.5:1, chữ lớn ≥ 3:1 — áp dụng cho **cả hai theme** (Neon Pitch tối + Candy Pop sáng).
- Điều hướng được bằng bàn phím; focus state rõ ràng.
- Tôn trọng `prefers-reduced-motion` cho mọi animation.
- Giao diện tiếng Việt; giữ nhãn/thông báo rõ nghĩa, tránh gray-on-tint khó đọc.
