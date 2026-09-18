import { createFileRoute, redirect } from "@tanstack/react-router";

const COPPER = "#C97857";
const COPPER_DEEP = "#B96849";
const PEACH = "#E8AE93";
const BLUSH = "#F2DFD6";
const SAGE = "#49A878";
const SKY = "#667C96";
const LIGHT_CANVAS = "#FAF7F3";
const LIGHT_CARD = "#FFFDFC";
const LIGHT_INK = "#14171B";
const LIGHT_MUTED = "#64686F";
const LIGHT_HAIRLINE = "#E3DDD8";
const DARK_CANVAS = "#0F1620";
const DARK_CARD = "#151B22";
const DARK_INK = "#F6F2EF";
const DARK_MUTED = "#A9B0B8";
const DARK_HAIRLINE = "rgba(255,255,255,0.08)";
const DARK_COPPER = "#E08A66";

const SWATCHES: ReadonlyArray<{ name: string; value: string; dark?: string }> = [
  { name: "Copper", value: COPPER, dark: DARK_COPPER },
  { name: "Burnt copper", value: COPPER_DEEP },
  { name: "Peach", value: PEACH },
  { name: "Soft blush", value: BLUSH },
  { name: "Sage", value: SAGE },
  { name: "Sky", value: SKY },
  { name: "Canvas", value: LIGHT_CANVAS, dark: DARK_CANVAS },
  { name: "Card", value: LIGHT_CARD, dark: DARK_CARD },
  { name: "Ink", value: LIGHT_INK, dark: DARK_INK },
];

function PhoneFrame({
  title,
  dark,
  children,
}: {
  title: string;
  dark?: boolean;
  children: React.ReactNode;
}) {
  const canvas = dark ? DARK_CANVAS : LIGHT_CANVAS;
  const card = dark ? DARK_CARD : LIGHT_CARD;
  const ink = dark ? DARK_INK : LIGHT_INK;
  const muted = dark ? DARK_MUTED : LIGHT_MUTED;
  const hairline = dark ? DARK_HAIRLINE : LIGHT_HAIRLINE;
  const copper = dark ? DARK_COPPER : COPPER;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: LIGHT_MUTED }}>{title}</div>
      <div
        style={{
          width: 300,
          height: 560,
          borderRadius: 36,
          border: `1px solid ${hairline}`,
          background: canvas,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            padding: "20px 20px 0",
            color: muted,
            fontSize: 11,
            letterSpacing: 3,
            textAlign: "center",
          }}
        >
          CIRCE
        </div>
        <div style={{ flex: 1, padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
          {children}
        </div>
        <div
          style={{
            display: "flex",
            borderTop: `1px solid ${hairline}`,
            background: card,
            padding: "8px 0 20px",
          }}
        >
          {["Home", "Tasks", "Library"].map((tab) => {
            const active = tab === "Home";
            return (
              <div
                key={tab}
                style={{
                  flex: 1,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 2,
                  color: active ? copper : muted,
                  fontSize: 11,
                  fontWeight: 700,
                }}
              >
                <span style={{ fontSize: 18 }}>
                  {tab === "Home" ? "⌂" : tab === "Tasks" ? "☰" : "▤"}
                </span>
                {tab}
              </div>
            );
          })}
        </div>
        <div style={{ display: "none" }}>{ink}</div>
      </div>
    </div>
  );
}

function CircePreview() {
  return (
    <div style={{ padding: 32, display: "flex", flexDirection: "column", gap: 32, maxWidth: 1100 }}>
      <div>
        <h1 style={{ fontSize: 28, margin: 0 }}>Circe mobile preview</h1>
        <p style={{ color: LIGHT_MUTED, fontSize: 14 }}>
          Step 1: copper and ivory tokens plus the Home, Tasks, and Library tab bar. Static mock for
          visual review; the real mobile screens bind the same tokens.
        </p>
      </div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {SWATCHES.map((swatch) => (
          <div key={swatch.name} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              style={{
                width: 28,
                height: 28,
                borderRadius: 8,
                background: swatch.value,
                border: `1px solid ${LIGHT_HAIRLINE}`,
                display: "inline-block",
              }}
            />
            <span style={{ fontSize: 12 }}>
              {swatch.name} <code>{swatch.value}</code>
              {swatch.dark ? (
                <>
                  {" / "} <code>{swatch.dark}</code>
                </>
              ) : null}
            </span>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
        <PhoneFrame title="Light / Home">
          <div
            style={{
              fontFamily: "Georgia, 'Times New Roman', serif",
              fontSize: 30,
              color: LIGHT_INK,
            }}
          >
            Good evening, <span style={{ color: COPPER }}>Parv.</span>
          </div>
          <div style={{ fontSize: 14, color: LIGHT_MUTED }}>What shall we do today?</div>
          <div
            style={{
              borderRadius: 999,
              background: LIGHT_CARD,
              border: `1px solid ${LIGHT_HAIRLINE}`,
              padding: "8px 14px",
              fontSize: 12,
              color: LIGHT_MUTED,
              alignSelf: "flex-start",
            }}
          >
            <span style={{ color: SAGE }}>●</span> Ready · Across all your machines
          </div>
          <div
            style={{
              borderRadius: 16,
              background: LIGHT_CARD,
              border: `1px solid ${LIGHT_HAIRLINE}`,
              padding: 14,
              fontSize: 13,
              color: LIGHT_MUTED,
            }}
          >
            Message Circe…
          </div>
        </PhoneFrame>
        <PhoneFrame title="Light / Tasks">
          <div
            style={{
              fontFamily: "Georgia, 'Times New Roman', serif",
              fontSize: 26,
              color: LIGHT_INK,
            }}
          >
            Tasks
          </div>
          <div style={{ fontSize: 13, color: LIGHT_MUTED }}>All your work, in motion.</div>
          {[
            { title: "Fix auth tests in Rivvl", state: "Running · 2 of 6 steps", color: COPPER },
            { title: "Summarise unread emails", state: "Completed", color: SAGE },
            {
              title: "Draft product update",
              state: "Scheduled · Today, 4:00 PM",
              color: LIGHT_MUTED,
            },
          ].map((task) => (
            <div
              key={task.title}
              style={{
                borderRadius: 16,
                background: LIGHT_CARD,
                border: `1px solid ${LIGHT_HAIRLINE}`,
                padding: 14,
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}
            >
              <div style={{ fontSize: 14, fontWeight: 600, color: LIGHT_INK }}>{task.title}</div>
              <div style={{ fontSize: 12, color: task.color }}>{task.state}</div>
            </div>
          ))}
        </PhoneFrame>
        <PhoneFrame title="Dark / Listening" dark>
          <div
            style={{
              fontFamily: "Georgia, 'Times New Roman', serif",
              fontSize: 26,
              color: DARK_INK,
              textAlign: "center",
              marginTop: 60,
            }}
          >
            Listening…
          </div>
          <div style={{ fontSize: 14, color: DARK_MUTED, textAlign: "center" }}>
            Speak naturally. I&apos;m here.
          </div>
          <div
            style={{
              width: 140,
              height: 140,
              borderRadius: "50%",
              margin: "24px auto",
              background: `radial-gradient(circle at 35% 30%, ${BLUSH}, ${COPPER} 55%, ${COPPER_DEEP})`,
              boxShadow: `0 0 60px ${COPPER}55`,
            }}
          />
          <div style={{ fontSize: 12, color: SKY, textAlign: "center" }}>Remote activity</div>
        </PhoneFrame>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/circe-preview")({
  beforeLoad: ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: CircePreview,
});
