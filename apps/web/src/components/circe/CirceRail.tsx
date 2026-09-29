import { useLocation, useNavigate } from "@tanstack/react-router";
import { MicIcon, PlusIcon, SearchIcon, SettingsIcon } from "lucide-react";
import { memo, useEffect, type ReactElement } from "react";
import { useAtomValue } from "@effect/atom-react";

import { openCommandPalette } from "../../commandPaletteBus";
import { shortcutLabelForCommand } from "../../keybindings";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { CIRCE_RAIL_MARK_SRC } from "./CirceBrand";
import { toggleCirceLiveVoiceFromUser } from "./CirceLiveVoice.bridge";
import {
  destinationHasPanel,
  PRESENCE_WORD,
  rememberTaskHref,
  resolveCirceDestination,
  useCirceMachines,
  useCirceNavigate,
  useCirceNavItems,
  useLiveVoiceListening,
  useNeedsYouCount,
  type CirceNavItem,
} from "./CirceNav";
import { Presence } from "./ui/StatusGlyph";

import "./circe-shell.css";

/** Lowercase two-character tile label from a node name: "forge" -> "fo". */
export function railNodeMonogram(label: string): string {
  const letters = label.toLowerCase().replace(/[^a-z0-9]/g, "");
  return letters.slice(0, 2) || "?";
}

function RailTip({ label, children }: { readonly label: string; readonly children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipPopup side="right">{label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * The rail picks where you are; the inset panel beside it lists what is
 * inside that place. Pressing the current destination again folds its
 * panel. Machine tiles open that machine on Home and never start work.
 */
export const CirceRail = memo(function CirceRail({
  macos,
  electron,
}: {
  readonly macos: boolean;
  readonly electron: boolean;
}) {
  const navigate = useNavigate();
  const href = useLocation({ select: (location) => location.href });
  const pathname = useLocation({ select: (location) => location.pathname });
  const destination = resolveCirceDestination(pathname);
  const { open, setOpen } = useSidebar();
  const needs = useNeedsYouCount();
  const listening = useLiveVoiceListening();
  const navItems = useCirceNavItems();
  const machines = useCirceMachines();
  const go = useCirceNavigate();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const paletteShortcut = shortcutLabelForCommand(keybindings, "commandPalette.toggle");
  const panelShortcut = shortcutLabelForCommand(keybindings, "sidebar.toggle");

  useEffect(() => {
    if (destination === "tasks" && pathname !== "/") rememberTaskHref(href);
  }, [destination, href, pathname]);

  const select = (id: CirceNavItem["id"]) => {
    if (id === destination && destinationHasPanel(id)) {
      setOpen(!open);
      return;
    }
    if (destinationHasPanel(id)) setOpen(true);
    go(id);
  };

  const tipFor = (item: CirceNavItem) => {
    const needsNote =
      item.id === "tasks" && needs > 0 ? `, ${needs} need${needs === 1 ? "s" : ""} you` : "";
    if (item.id !== destination || !destinationHasPanel(item.id)) return item.label + needsNote;
    const action = open ? "Hide list" : "Show list";
    return `${item.label}${needsNote}. ${action}${panelShortcut ? `  ${panelShortcut}` : ""}`;
  };

  return (
    <nav
      className="ci-rail"
      aria-label="Circe"
      data-macos={macos ? "true" : "false"}
      data-drag={electron ? "true" : "false"}
    >
      <RailTip label="Home">
        <button
          type="button"
          className="ci-rail__mark"
          aria-label="Home"
          aria-current={destination === "home" ? "page" : undefined}
          data-active={destination === "home" ? "true" : "false"}
          onClick={() => go("home")}
        >
          <img alt="" src={CIRCE_RAIL_MARK_SRC} />
        </button>
      </RailTip>

      <div className="ci-rail__group">
        {navItems.map((item) => {
          const Icon = item.icon;
          const active = destination === item.id;
          return (
            <RailTip key={item.id} label={tipFor(item)}>
              <button
                type="button"
                className="ci-rail__btn"
                aria-label={
                  item.id === "tasks" && needs > 0 ? `Tasks, ${needs} need you` : item.label
                }
                aria-current={active ? "page" : undefined}
                data-active={active ? "true" : "false"}
                onClick={() => select(item.id)}
              >
                <Icon />
                {item.id === "tasks" && needs > 0 ? (
                  <span className="ci-rail__badge">{needs > 99 ? "99+" : needs}</span>
                ) : null}
              </button>
            </RailTip>
          );
        })}
      </div>

      <div className="ci-rail__rule" />

      <div className="ci-rail__group ci-rail__machines" aria-label="Machines">
        {machines.map((machine) => {
          const Icon = machine.icon;
          return (
            <RailTip
              key={machine.environmentId}
              label={`${machine.label}, ${PRESENCE_WORD[machine.presence]}${machine.current ? ", this machine" : ""}`}
            >
              <button
                type="button"
                className="ci-rail__machine"
                aria-label={`${machine.label}, ${PRESENCE_WORD[machine.presence]}`}
                data-offline={machine.presence === "offline" ? "true" : "false"}
                onClick={() =>
                  void navigate({ to: "/circe", search: { machine: machine.environmentId } })
                }
              >
                {machines.length > 1 ? (
                  <span className="ci-rail__monogram">{railNodeMonogram(machine.label)}</span>
                ) : (
                  <Icon />
                )}
                <Presence state={machine.presence} ring="var(--chrome)" />
              </button>
            </RailTip>
          );
        })}
        <RailTip label="Pair a machine">
          <button
            type="button"
            className="ci-rail__machine ci-rail__machine--add"
            aria-label="Pair a machine"
            onClick={() => void navigate({ to: "/settings/connections" })}
          >
            <PlusIcon />
          </button>
        </RailTip>
      </div>

      <div className="ci-rail__spacer" />

      <div className="ci-rail__group">
        <RailTip label={`Search${paletteShortcut ? `  ${paletteShortcut}` : ""}`}>
          <button
            type="button"
            className="ci-rail__btn"
            aria-label="Search"
            onClick={() => openCommandPalette()}
          >
            <SearchIcon />
          </button>
        </RailTip>
        <RailTip label={listening ? "End conversation" : "Talk to Circe"}>
          <button
            type="button"
            className="ci-rail__btn ci-rail__mic"
            aria-label={listening ? "End conversation with Circe" : "Talk to Circe"}
            aria-pressed={listening}
            data-listening={listening ? "true" : "false"}
            onClick={toggleCirceLiveVoiceFromUser}
          >
            <MicIcon />
          </button>
        </RailTip>
        <RailTip label="Settings">
          <button
            type="button"
            className="ci-rail__btn"
            aria-label="Settings"
            aria-current={destination === "settings" ? "page" : undefined}
            data-active={destination === "settings" ? "true" : "false"}
            onClick={() => {
              setOpen(true);
              void navigate({ to: "/settings" });
            }}
          >
            <SettingsIcon />
          </button>
        </RailTip>
      </div>
    </nav>
  );
});
