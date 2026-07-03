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

- Bản **portable**: Windows (đã kèm sẵn Node + Ollama, không cần cài gì).
- Bản **mã nguồn**: Windows / macOS / Linux — cần tự cài [Ollama](https://ollama.com) và Node.js 18+.
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

## Phần mềm diệt virus & cảnh báo hệ điều hành

Ứng dụng **không chứa mã độc**, nhưng vì bản portable đi kèm file thực thi
(`node.exe`, `ollama.exe`) và script tự khởi động (`.bat`, `.ps1` tạo tác vụ
chạy nền), một số phần mềm diệt virus / hệ điều hành có thể **cảnh báo nhầm**.
Cách xử lý theo hệ điều hành:

**Windows** (bản portable)
- SmartScreen báo "Windows protected your PC": bấm **More info → Run anyway**.
- Nên **chép qua USB/mạng nội bộ** thay vì tải từ trình duyệt (tránh "Mark of the Web").
- Nếu Defender/Kaspersky chặn: thêm **thư mục giải nén vào ngoại lệ (exclusion/whitelist)**.
- File hay bị soi nhất là `CaiTuKhoiDong.bat` (tạo tác vụ tự khởi động). Nếu bị
  chặn, có thể **bỏ phần tự khởi động** và chỉ chạy thủ công bằng `Chatbot.bat`.
- KHÔNG dùng bản đóng gói `.exe` (ps2exe) trên máy này — Kaspersky xóa nhầm; dùng `.bat`.

**macOS** (chạy từ mã nguồn — bản portable Windows không chạy trên Mac)
- Cài Node.js + Ollama, rồi `npm install` và `npm start` (xem mục Cách chạy).
- Gatekeeper báo "không xác minh được nhà phát triển": **chuột phải → Open**, hoặc
  gỡ cờ cách ly: `xattr -dr com.apple.quarantine <thư-mục>`.

**Linux** (chạy từ mã nguồn)
- Cài Node.js + Ollama, rồi `npm install` và `npm start`.
- Thường không bị AV chặn; nếu cần thì cấp quyền chạy: `chmod +x` cho script.

> Muốn hết sạch cảnh báo cần **ký số (code signing)** — cần mua chứng chỉ, hơi
> quá mức cho dùng nội bộ. Cách thực tế nhất: thêm ngoại lệ AV cho thư mục app.

## Cấu trúc

| File | Vai trò |
|---|---|
| `server.js` | Máy chủ web, định tuyến API |
| `db.js` | Cơ sở dữ liệu PGlite, embedding, RAG |
| `parse.js` | Đọc file Excel/CSV/PDF/Word |
| `env.js` | Nạp cấu hình từ `.env` |
| `public/` | Giao diện (chat, quản trị) |
| `build-portable.ps1` | Đóng gói bản portable |
