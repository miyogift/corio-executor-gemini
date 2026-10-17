# Gemini CLI 执行器扩展

本包通过公开 corio-executor-sdk 管理 Gemini CLI 的安装、配置、认证、单次执行、精确续接、只读历史及用量，不导入 Manager 的私有业务代码。默认原生 npm 版本为 `0.61.0`；扩展包版本与原生程序版本分别登记。

```sh
npm install
npm test
npm pack
```

发布制品包括清单、Skills 和 `dist`。原生安装只发生在生命周期方法中，导入本包不启动进程或登录。

每个 Agent 的原生父目录为 `stateDirectory/native`；Gemini 设置、OAuth 和历史实际保存在其中的 `.gemini`。模型连接明确使用 `google_generate_content`，认证由宿主提供 API Key；Base URL 原样交给原生 SDK，密钥不进入命令参数。设备登录默认从本设备 ~/.gemini 一次性导入 `oauth_creds.json`，或按 Dashboard 返回的终端说明完成 Google 登录；不复制设备的 MCP、历史或其他 Agent 数据。

提示通过标准输入传入，然后调用宿主 `endInput()` 发送 EOF。每次 execution 创建独立进程、注入该次 Corio 身份；续接必须是确切 UUID 和本设备已有的会话。程序结束或中断不自动重放输入。原生输出仅作为内部详情；群回复、审批、交付和其他业务动作需使用 Corio CLI。

原生 JSONL 查询恢复消息编辑和 rewind，标题取原生 title/summary，缺失保持空值。Gemini stream-json 没有公开稳定 turn ID，本包不拿消息 ID 代替；当前不支持 agent turn 的原生结构化输出 Schema。查询不会发起模型推理。

用量按一次原生命令的 `call` 累计处理，保留 stats.models 中实际多个模型、未缓存输入、缓存输入和输出，不把各模型明细与总量重复相加，也不猜费用或官方厂商。

协议依据：[headless](https://geminicli.com/docs/cli/headless/)、[认证](https://geminicli.com/docs/get-started/authentication/)、[配置](https://geminicli.com/docs/reference/configuration/)。版本对应的原生实现是最终核对依据。

执行器清单只声明公共元数据、type、executorType、providers、supportCustomModelProvider。设备认证按 from-device 使用本设备标准认证位置；每个 Agent 使用自己的原生配置目录，不导入设备的全局 MCP 或历史。详情见第 30 章。
