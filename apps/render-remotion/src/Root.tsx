/**
 * One composition per template. The id is what the worker passes to `remotion render`; the worker maps the scene
 * plan's template (the style id) to it in REMOTION_COMPOSITIONS.
 */
import React from "react";
import { Composition, type CalculateMetadataFunction } from "remotion";
import { FlatVectorExplainer } from "./FlatVectorExplainer.tsx";
import { SAMPLE_PROPS, timelineFor, type TemplateProps } from "./props.ts";

/** Size, frame rate and length come from the job's props, so one composition serves short and long formats. */
export const metadataFromProps: CalculateMetadataFunction<TemplateProps> = ({ props }) => {
  const timeline = props.timeline ?? timelineFor(props.shots.map((s) => s.seconds), props.transitionSec, props.fps);
  return { durationInFrames: timeline.totalFrames, width: props.width, height: props.height, fps: props.fps };
};

const sample = timelineFor(SAMPLE_PROPS.shots.map((s) => s.seconds), SAMPLE_PROPS.transitionSec, SAMPLE_PROPS.fps);

export const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="flat-vector-explainer"
      component={FlatVectorExplainer}
      defaultProps={SAMPLE_PROPS}
      calculateMetadata={metadataFromProps}
      width={SAMPLE_PROPS.width}
      height={SAMPLE_PROPS.height}
      fps={SAMPLE_PROPS.fps}
      durationInFrames={sample.totalFrames}
    />
  </>
);
