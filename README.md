# GPT Image2 NapCat Bot

一个基于 `NapCat WebSocket + OpenAI SDK + CLIProxyAPI` 的 QQ 群机器人。

当前支持两类能力：

- `@机器人 生图 ...`
  使用 `gpt-5.4 + gpt-image-2` 生成图片
- 回复一张图片并发送 `反推 ...`
  读取被回复图片，反推成适合 `gpt-image-2` 的提示词

## 工作方式

项目由两个核心脚本组成：

- [napcat_ws.js](./napcat_ws.js)
  连接 NapCat WebSocket，监听群消息、解析命令、排队执行任务、回发结果
- [get_img.js](./get_img.js)
  调用 OpenAI / CLIProxyAPI：
  - 生图
  - 识图 / 反推提示词

## 依赖

- Node.js 20+
- 一个可用的 NapCat WebSocket 服务
- 一个可用的 `OPENAI_API_KEY`
- 当前默认通过 `CLIProxyAPI` 转发到：
  - `http://127.0.0.1:8317/v1`

## 安装

```bash
npm install
```

## 环境变量

请先复制一份 `.env.example`：

```bash
cp .env.example .env
```

然后填写：

```env
OPENAI_API_KEY=sk-xxx
WHITELIST=["861369046"]
```

说明：

- `OPENAI_API_KEY`
  传给 OpenAI SDK 的 key
- `WHITELIST`
  允许机器人响应的群号列表，格式是 JSON 数组字符串

例如：

```env
WHITELIST=["861369046","123456789"]
```

如果需要更多调试日志，可以加：

```env
DEBUG=1
```

## 运行

直接启动：

```bash
node napcat_ws.js
```

如果想看更详细日志：

```bash
DEBUG=1 node napcat_ws.js
```

## 命令说明

### 1. 生图

在白名单群内：

```text
@机器人 生图 一只在月球上喝咖啡的橘猫
```

机器人会：

1. 检测是否 @ 到自己
2. 将任务加入本地队列
3. 串行调用 `gpt-image-2`
4. 通过合并转发把图片发回群里

### 2. 基于回复内容继续生图

如果回复了一条包含文本提示词的消息，再发送：

```text
生图 让它变成赛博朋克风格
```

机器人会先读取被回复消息，再把原始提示词和你的补充提示词拼起来继续生图。

### 3. 图片反推

回复一张图片后发送：

```text
反推
```

机器人会尝试读取那张图片，并调用模型生成适合 `gpt-image-2` 的描述词。

### 4. 帮助

群里发送：

```text
/help
```

## 日志

项目里已经做了简单日志规范化：

- `[napcat]`
  NapCat 机器人运行日志
- `[napcat:debug]`
  NapCat 调试日志，仅在 `DEBUG=1` 时输出
- `[image]`
  生图 / 识图日志
- `[image:debug]`
  流式调试日志，仅在 `DEBUG=1` 时输出

## 已知限制

### 1. `CLIProxyAPI` 非流式返回不稳定

当前链路下，`gpt-5.4` 的非流式结果经常为空，所以图片和识图逻辑主要依赖流式响应。

### 2. NapCat 如果运行在 Docker 内，图片路径要额外处理

当前代码里发图使用的是本地文件路径：

```text
file:///absolute/path/to/image.png
```

如果 NapCat 在 Docker 容器里运行，而图片保存在宿主机目录，容器内可能读不到这个文件。

这时通常需要：

- 给容器挂载宿主机图片目录
或
- 改成 HTTP URL 发图

### 3. 合并转发 / reply / forward 的消息结构可能在不同环境下不一致

本地与服务器上，NapCat 返回的消息结构可能略有差异，尤其是：

- `reply`
- `forward`
- 图片段字段

如果某个逻辑本地正常、服务器异常，优先打印完整回包排查。

## 项目结构

```text
.
├── .env.example
├── .gitignore
├── get_img.js
├── napcat_ws.js
├── output/
├── package.json
└── README.md
```

## 后续可改进项

- 把 NapCat token 改成环境变量
- 把 task 结构统一成显式类型
- 给 `get_msg` Promise 加超时与失败处理
- 把图片发送切到 HTTP URL，减少 Docker 文件路径问题
- 清理 `get_img.js` 里的临时调试逻辑和本地假返回
