# AVT Chat Bot

Trợ lý AI chạy hoàn toàn trên máy chủ nội bộ doanh nghiệp. Không dùng cloud, không gửi dữ liệu ra internet. Dùng để hỏi đáp, tra cứu tài liệu và bảng giá, soạn báo giá tối ưu.

## Đặc điểm

- Chạy 100% local: Ollama (LLM) + PGlite (Postgres nhúng, không cần Docker).
- RAG: nạp tài liệu và bảng giá, bot trả lời dựa trên dữ liệu của bạn.
- Nhập liệu linh hoạt: gõ tay hoặc tải file Excel/CSV/PDF/Word/TXT.
- Tư vấn báo giá tối ưu từ bảng giá đã nạp.
- Nhiều cuộc hội thoại, tùy chọn ghi nhớ xuyên hội thoại.
- Quản lý model, xuất file (Word/Excel/PDF), mẫu câu lệnh, trạng thái hệ thống, tìm kiếm.
- Cài như app (PWA), tự khởi động khi bật máy (tùy chọn).
- Giao diện 3 theme: Sáng / Tối / Coffee.

## Yêu cầu

- Windows.
- [Ollama](https://ollama.com) và Node.js 18+ (bản portable đã kèm sẵn, không cần cài).
- 2 model: `qwen2.5:3b` (chat) và `bge-m3` (embedding cho RAG).

## Cách chạy

### Bản portable (khuyên dùng, không cần cài gì)

1. Giải nén file zip ra một thư mục.
2. Bấm đúp `Chatbot.bat`.
3. Trình duyệt tự mở `http://localhost:3000`.

Đã kèm sẵn Node, Ollama và 2 model. Không cần internet.

### Bản mã nguồn (cho lập trình viên)

```bash
npm install
ollama pull qwen2.5:3b
ollama pull bge-m3
npm start
```

Mở `http://localhost:3000` (chat) và `/admin.html` (nhập liệu, quản trị).

## Tự khởi động khi bật máy (tùy chọn)

- Bật: chuột phải `CaiTuKhoiDong.bat` -> Run as administrator.
- Tắt: chuột phải `GoTuKhoiDong.bat` -> Run as administrator.

Chatbot tự chạy khi bật máy, không cần đăng nhập.

## Cấu hình

Sao chép `.env.example` thành `.env` rồi chỉnh nếu cần:

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | 3000 | Cổng web |
| `OLLAMA_URL` | http://localhost:11434 | Địa chỉ Ollama |
| `MODEL` | qwen2.5:3b | Model trả lời |
| `EMBED_MODEL` | bge-m3 | Model embedding (đổi phải nạp lại dữ liệu) |
| `EMBED_DIM` | 1024 | Số chiều vector |
| `MAX_UPLOAD_MB` | 200 | Giới hạn dung lượng file tải lên |
| `DATA_DIR` | pgdata | Thư mục dữ liệu |

## Bảo mật

- Dữ liệu nghiệp vụ (báo giá, hợp đồng, lịch sử chat) nằm trong thư mục `pgdata`, không rời khỏi máy.
- Không mở cổng ra internet, không port-forward. Chỉ dùng trong mạng nội bộ.
- `pgdata` và `.env` đã được loại khỏi git.

## Cấu trúc

| File | Vai trò |
|---|---|
| `server.js` | Máy chủ web, định tuyến API |
| `db.js` | Cơ sở dữ liệu PGlite, embedding, RAG |
| `parse.js` | Đọc file Excel/CSV/PDF/Word |
| `env.js` | Nạp cấu hình từ `.env` |
| `public/` | Giao diện (chat, quản trị) |
| `build-portable.ps1` | Đóng gói bản portable |
