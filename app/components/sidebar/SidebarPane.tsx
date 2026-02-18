import TweakpaneControls from "@/app/state/TweakpaneControls";
import ControlsHelp from "./ControlsHelp";
import ExplainerCard from "./ExplainerCard";

export default function SidebarPane() {
  return (
    <aside
      style={{
        position: "relative",
        top: 0,
        right: 0,
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        backdropFilter: "blur(6px)",
        background: "rgba(18,18,20,0.55)",
        borderLeft: "1px solid rgba(255,255,255,0.08)",
        zIndex: 1000,
        overflow: "hidden", 
      }}
    >
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          overflowX: "hidden",
          WebkitOverflowScrolling: "touch",
        }}
      >
        <ExplainerCard />
        <ControlsHelp />
        <TweakpaneControls />
      </div>
    </aside>
  );
}
