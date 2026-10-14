<template>
  <div
    class="dictation-root"
    :class="{ visible: isVisible }"
    ref="dictationRoot"
  >
    <div class="dictation-container">
      <div class="status-icn" :class="currentStatus">
        <!-- Microphone icon for idle and recording states -->
        <i
          v-if="currentStatus === 'idle' || currentStatus === 'recording'"
          class="ph-duotone ph-microphone"
        ></i>

        <!-- Spinner icon for transcribing state -->
        <i
          v-else-if="currentStatus === 'transcribing'"
          class="ph ph-spinner"
        ></i>

        <!-- Sparkle icon for transforming state -->
        <i
          v-else-if="currentStatus === 'transforming'"
          class="ph-duotone ph-sparkle"
        ></i>

        <!-- Paper plane icon for injecting state -->
        <i
          v-else-if="currentStatus === 'injecting'"
          class="ph-duotone ph-paper-plane-tilt"
        ></i>

        <!-- Check icon for complete state -->
        <i
          v-else-if="currentStatus === 'complete'"
          class="ph-duotone ph-check-circle"
        ></i>
      </div>

      <div class="text-scroll-container" :class="{ warming: warmupMessage }" ref="textScrollContainer">
        <span v-if="warmupMessage" role="status" aria-live="polite" class="warmup-message">{{ warmupMessage }}</span>
        <div v-show="!warmupMessage" class="wave-container" :class="{ active: showVisualizer }">
          <canvas
            id="waveCanvas"
            class="wave-canvas"
            height="24"
            ref="visualizerCanvas"
          ></canvas>
        </div>
        <div v-show="!warmupMessage" class="text-content" ref="textContent">
          <template v-if="!showVisualizer">
            <template v-if="displaySegments.length > 0">
              <span
                v-for="(segment, index) in displaySegments"
                :key="segment.id || index"
                class="text-segment"
                :class="[
                  getSegmentClass(segment),
                  { 'no-caret': currentStatus === 'transcribing' },
                ]"
              >
                <!-- Completed Segment -->
                <template v-if="segment.completed">{{ segment.text }}</template>
                <!-- In-Progress Segment -->
                <template v-else>
                  <span>{{
                    segment.text ||
                    (currentStatus === "transcribing" ? "Transcribing..." : "")
                  }}</span>
                  <i
                    v-if="currentStatus === 'transcribing'"
                    class="ph ph-spinner in-progress-spinner"
                  ></i>
                </template>
              </span>
            </template>
            <!-- Fallbacks for when there are no segments -->
            <template v-else>
              <span
                v-if="currentStatus === 'transcribing'"
                class="text-segment in-progress"
                >Transcribing...<i class="ph ph-spinner in-progress-spinner"></i
              ></span>
              <span
                v-else-if="
                  currentStatus === 'transforming' ||
                  currentStatus === 'injecting'
                "
                class="text-segment in-progress"
                >Processing...</span
              >
              <span v-else class="text-segment" style="opacity: 0">&nbsp;</span>
            </template>
          </template>
        </div>
      </div>

      <button v-if="warmupMessage" class="warmup-cancel-button" @click="handleClose">
        Cancel warm-up
      </button>
      <button v-else class="close-button" aria-label="Cancel dictation" @click="handleClose">
        <i class="ph-duotone ph-x"></i>
      </button>
    </div>
  </div>
</template>
<script>
import dictationComponent from "../scripts/dictation.js";
export default dictationComponent;
</script>

<style lang="less">
@import "../styles/dictation.less";
 .dictation-root {
  .text-scroll-container.warming { height: 32px; }
  .warmup-message {
    display: block;
    font-size: 12px;
    line-height: 16px;
    white-space: pre-line;
    opacity: 0.9;
  }
  .warmup-cancel-button {
    flex-shrink: 0;
    padding: 5px 9px;
    border: 1px solid rgba(0, 0, 0, 0.25);
    border-radius: 6px;
    background: linear-gradient(#fff, #e8e8ec);
    color: #242426;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.9), 0 1px 2px rgba(0, 0, 0, 0.16);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
    -webkit-app-region: no-drag;
    &:hover { background: linear-gradient(#fff, #dcdce3); }
    &:active { box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.22); }
    &:focus-visible { outline: 2px solid #007aff; outline-offset: 2px; }
  }
}
</style>
