# brainhouse pipeline snapshot

panel: `p_8f3a`
event: `e_b1c2`  (index 47 of 213)
captured: 2026-06-08T14:22:11Z
runner: v2 (selector dispatch)

## Raw event

```json
{
  "uuid": "e_b1c2",
  "parent_uuid": null,
  "session_id": "p_8f3a",
  "agent_id": null,
  "ts": "2026-06-08T14:22:00Z",
  "cwd": null,
  "kind": "user_text",
  "payload": {
    "text": "hello there"
  }
}
```

## Stage 1 trace

| transform | matched | ran | consumed | mutated | error |
|-----------|:-:|:-:|:-:|:-:|:--|
| stripBhTitleMarker | ✓ | ✓ |   | ✓ |  |
| tagBtwUserText | ✓ | ✓ |   | ✓ |  |
| bashTerminal |   |   |   |   |  |
| userTextBubble | ✓ | ✓ | ✓ | ✓ |  |

(disabled: `toolUseCapsule`, `subagentBanner`)

## Stage 2 trace

| transform | mutated | beforeLen → afterLen | error |
|-----------|:-:|:-:|:--|
| coalesceAdjacentBubbles | ✓ | 214 → 211 |  |

## Resulting view items

```json
[
  {
    "type": "bubble",
    "event": {
      "uuid": "e_b1c2",
      "parent_uuid": null,
      "session_id": "p_8f3a",
      "agent_id": null,
      "ts": "2026-06-08T14:22:00Z",
      "cwd": null,
      "kind": "user_text",
      "payload": {
        "text": "hello there"
      }
    },
    "role": "user",
    "parts": [
      {
        "kind": "text",
        "text": "hello there"
      }
    ]
  }
]
```

## Toggles (panel-local)

enabled: stripBhTitleMarker, tagBtwUserText, bashTerminal, userTextBubble, coalesceAdjacentBubbles
disabled: toolUseCapsule, subagentBanner
