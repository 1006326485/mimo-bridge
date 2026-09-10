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
# 按需改 bridgePort / bridgeKey / defaultSid
node server.js
# pm2
pm2 start ecosystem.config.js
pm2 save
```

## 接口

- `GET /health`：桥 + Desktop 健康
- `GET /v1/models`：三个免费模型
- `POST /v1/chat/completions`：OpenAI 兼容，`model` 三选一，`stream` 支持 `true/false`

```bash
curl -s -X POST http://127.0.0.1:3777/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"mimo-x-flash-preview","messages":[{"role":"user","content":"hi"}],"stream":false}'
```

`config.json` 里按需设置 `bridgeKey` 启用鉴权。`defaultSid` 用已有会话 id。

## 注意

- 只绑 `127.0.0.1`，不要对外暴露；`desktop-api.json` 会随 App 重启轮换，桥已自动重载。
- `401` 重读一次 token，`503 not-logged-in` 去 App 重登。
- 免费通道跟账号绑定，仅限本机自用，注意小米 ToS。
