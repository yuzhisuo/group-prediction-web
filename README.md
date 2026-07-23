# 群聊积分预测固定链接版

这是一个手机网页项目。部署完成后，把 Render 提供的 HTTPS 链接发到 QQ 群，群友可直接在 QQ 内置浏览器使用。

## 功能

- 创建多个预测题并生成数字 ID
- 输入题目 ID、参与者 ID 和虚拟积分
- 红方、蓝方实时积分占比条
- 实时参考系数
- WebSocket 自动同步
- 同一参与者在同一题目再次提交时覆盖原选择
- 本地 SQLite，云端 PostgreSQL
- 自适应手机和电脑屏幕

## 使用边界

虚拟积分无货币价值，不支持充值、提现、转让、兑换、现金结算或实物奖励。

## 本地启动

```bash
python -m venv .venv
```

Windows：

```bat
.venv\Scripts\activate
```

macOS/Linux：

```bash
source .venv/bin/activate
```

安装并启动：

```bash
python -m pip install -r requirements.txt
python -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

浏览器打开：

- 页面：http://127.0.0.1:8000
- 健康检查：http://127.0.0.1:8000/health
- API 文档：http://127.0.0.1:8000/docs

## 云端环境变量

- `DATABASE_URL`：Neon PostgreSQL 连接字符串
- `APP_NAME`：网页名称，可选

## Render 启动命令

```bash
uvicorn main:app --host 0.0.0.0 --port $PORT
```
