// Service worker tối thiểu — đủ điều kiện để trình duyệt cho "Cài đặt app".
// Không cache (app chạy local nên luôn lấy bản mới), chỉ chuyển tiếp request.
self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => self.clients.claim());
self.addEventListener('fetch', (e) => { /* passthrough: để trình duyệt tự lấy từ mạng/local */ });
