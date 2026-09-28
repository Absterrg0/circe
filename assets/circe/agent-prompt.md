# Circe UI checklist

Read `design-system.md` in this folder and use the tokens in `tokens.css`. Before adding anything to a screen:

- Does it glow? Only running work (ember), work that needs you (attention) and Circe listening (voice) glow, and only one gold thing per screen.
- Does every task name its machine?
- Is the status one of the fixed words (Running, Queued, Needs you, Completed, Failed, Offline, Settled) with its glyph?
- Is it a surface only because you act on it? Otherwise use space and a hairline.
- Is there exactly one primary (ember) button?
- Is the copy operational and short, in sentence case, with an ellipsis for work in progress?
- Would a disabled voice client stay idle, and does every loop stop under reduced motion?

If the result looks like a generic SaaS dashboard, remove things until it does not.
