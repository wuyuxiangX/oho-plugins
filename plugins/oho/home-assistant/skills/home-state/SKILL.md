---
name: home-state
description: Use this skill whenever the user asks about the current state of their home, rooms, lights, sensors, or other Home Assistant devices.
---

# Home state

- Call `GetLiveContext` before making any claim about a device's current state.
- Use only entities explicitly returned by Home Assistant. Do not invent or infer devices that are absent from the result.
- Prefer friendly device and room names. Do not expose access tokens, internal URLs, or entity identifiers unless the user explicitly needs an identifier.
- When the user asks for an overview, group the result by room or device type and highlight states that may need attention.
- This plugin is read-only. If the user asks to control a device, explain that device control is not enabled yet and do not claim that an action succeeded.
