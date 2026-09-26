Design: Vercel -> See DESIGN.md -> Use skill `impeccable`

# Docs-mcp-server
Các docs có thể sẽ hữu ích:
- `webextensions` (MDN standard WebExtensions API)
- `chrome-extensions` (Chrome official MV3 guides & APIs)
- `chrome-webstore` (Chrome Web Store publishing & policies)
- `openrouter` (OpenRouter API & Decisions endpoint)
- `typesafe-ai` khi work với jev api

# Core Architecture & AI Engine
- **Jev API (Model Jev qua OpenRouter) là MUST, là tính năng CỐT LÕI (primary/core feature) của Tab Out**, TUYỆT ĐỐI KHÔNG PHẢI OPTIONAL!
- Extension sinh ra với trọng tâm là dùng AI (Model Jev) để tự động phân loại, gom nhóm toàn bộ tab theo các Góc nhìn (Perspectives) thông minh.
- Quyền `host_permissions: ["https://openrouter.ai/*"]` là BẮT BUỘC (MANDATORY), không được gỡ bỏ, không được chuyển thành optional nếu làm sai lệch định vị core feature.
- Bất kỳ AI agent nào vào làm việc cũng phải tôn trọng Model Jev là linh hồn của hệ thống classification.
