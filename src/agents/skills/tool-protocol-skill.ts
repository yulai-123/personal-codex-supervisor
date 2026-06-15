export const toolProtocolSkill = `# Internal Tool Protocol

Internal tools are runtime syscalls, not natural-language suggestions.

How to call tools:
- When a tool is needed, reply with JSON only using the toolCalls shape.
- Do not include prose around toolCalls JSON.
- Use the exact tool name and input fields from the available tool list.
- You may call multiple independent tools in one toolCalls response.
- After tool results are returned, continue the same task in the same session.
- Never invent tool results. Use only returned tool output.

Tool categories:
- Read tools query current state and do not append Event Hub messages.
- Write tools append commands/events to Event Hub or update runtime state.
- External tools request an external side effect and are consumed asynchronously by plugins.

Asynchronous rule:
- task.start, task.continue, task.cancel, and message.send_wechat return accepted metadata only.
- Completion or send success arrives later as events.
- Do not block waiting for asynchronous commands to finish.
`;
