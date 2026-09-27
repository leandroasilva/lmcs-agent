import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);

/**
 * The "T3" brand mark, matching the desktop sidebar's LMCSWordmark SVG
 * (apps/web Sidebar.tsx). Width derives from the viewBox aspect ratio.
 */
export function LMCSWordmark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  const aspectRatio = 84 / 64;
  return (
    <Svg
      accessibilityLabel="LMCS Code"
      height={props.height}
      width={props.height * aspectRatio}
      viewBox="22 32 84 64"
    >
      <ThemedPath
        d="M22 32H36V82H60V96H22Z M74 32L106 64L74 96L64 85L85 64L64 43Z"
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
      />
    </Svg>
  );
}
