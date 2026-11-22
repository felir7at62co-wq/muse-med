/** Host-only receipt operations and speech-track helpers for tools that stage their own audio. */
export { extractSpeechPcm, finishAudioTranscription, probeMediaDuration, readPublishedSegments, SPEECH_SAMPLE_RATE,
  speechWavHeader, startAudioTranscription, startAudioTranscriptionBatch } from './runner.ts'
export type { AudioAccount, AudioBatchItem, AudioBatchResult, AudioMediaOperations, AudioQueryOptions, AudioRunResult,
  AudioRunnerConfig, AudioUploadPacing } from './runner.ts'
