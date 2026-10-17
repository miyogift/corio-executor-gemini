---
name: gemini-cli-executor
description: 在 Corio 中使用受管 Gemini CLI，查看原生会话或在协作 CLI 不足时直接调用原生程序。
---

优先使用 Corio 协作 CLI，使委派与业务动作由 Manager 自动关联到当前 execution。用 `corio delegate executors` 查看已配置的协作执行器，用 `corio delegate launch-info --executor gemini` 查看本 Agent 的运行入口；不要假设全局 gemini 命令或替换另一个 Agent 的认证目录。

手动调用时使用列表返回的可执行命令、当前 Agent 工作目录及其 GEMINI_CLI_HOME。用 `--output-format stream-json` 获取事件，将任务经标准输入传入并关闭输入；使用 `--resume <确切 UUID>` 续接，不使用 latest 或会话序号。原生 CLI 参数和模型能力可能迭代，以安装版本的 `--help` 为准。

原生工具事件和最终文本不会自动成为群消息。需要公开发言时随时调用 `corio group send`，其他业务操作使用对应 Corio 命令。执行器承担什么工作由任务、模型、上下文和自己的判断决定。
