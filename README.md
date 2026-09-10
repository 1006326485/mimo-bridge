# mimo-bridge

MiMo Desktop 免费通道桥：把本机已登录的 MiMo Desktop 包装成标准 OpenAI 兼容接口。

## 原理

`mimo-x-flash-preview / mimo-x-pro-preview / mimo-auto` 命中 Desktop 的 `proxy` 路：

`POST https://mimo-server-sgp.xiaomimimo.com/api/route/chat/completions`

靠 Xiaomi 登录态（本机 `Partitions/xiaomi-account` Cookie + STS），无需单独 API Key。

本桥复用本机 `desktop-api.json` 的 `port/token` 调 `POST /v1/sessions/{id}/turns`，
再轮询 `GET /v1/sessions/{id}/messages` 转回 OpenAI 格式。

## 快速开始

```bash
cp config.example.json config.json
# 填 keys 表：一项目一 Key，一 Key 一 Desktop 会话
node server.js
# pm2
pm2 start ecosystem.config.js
pm2 save
```

## 多项目多 agent（像真正的 provider 一样用）

每个调用方发自己的 Key，桥按 Key 路由到独立的 Desktop 会话，历史互不串味：

```json
{ "keys": [
  { "key": "KEY_FOR_PROJECT_A", "label": "project-a", "sid": "ses_AAA" },
  { "key": "KEY_FOR_AGENT_CODE", "label": "agent-code", "sid": "ses_BBB" }
]}
```

`sid` 去 Desktop 里新建一个空会话，从 `GET /v1/sessions` 抄它的 `id` 填上即可。
单次请求也可用 `"sid"` 字段临时覆盖。只发增量（最后一条 user），连续对话靠会话历史本身。

## 接口

- `GET /health`：桥 + Desktop 健康
- `GET /v1/models`：三个免费模型
- `POST /v1/chat/completions`：OpenAI 兼容，`model` 三选一，`stream` 支持 `true/false`，需 `Authorization: Bearer <你的Key>`
- `GET /admin/keys`：同 Key 鉴权，看各 Key 脱敏标识、绑定会话与调用计数
- `POST /admin/reload`：改完 `config.json` 热重载，不用重启

```bash
curl -s -X POST http://127.0.0.1:3777/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <你的Key>" \
  -d '{"model":"mimo-x-flash-preview","messages":[{"role":"user","content":"hi"}],"stream":false}'
```

## 注意

- 只绑 `127.0.0.1`，不要对外暴露；`desktop-api.json` 会随 App 重启轮换，桥已自动重载。
- `401` 重读一次 token，`503 not-logged-in` 去 App 重登。
- 免费通道跟账号绑定，仅限本机自用，注意小米 ToS。
