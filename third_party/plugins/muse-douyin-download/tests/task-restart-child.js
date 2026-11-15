/** Crash fixture: leave a real task lease after one verified item and before the next item settles. */
import { taskHarness } from './task-harness.js';
import { mediaReceipt, VIDEO_ONE, VIDEO_TWO, videoURL, selectedVideo } from './task-fixtures.js';

const admitted = Promise.withResolvers();
const waitingUser = process.argv[3] === 'waiting-user';
let accepted;
const fixture = await taskHarness(undefined, {
  directory: process.argv[2], ownerId: 'restart-owner', keepDirectory: true,
  async acquireVideo(agent, url) {
    await admitted.promise;
    if (selectedVideo(url) === VIDEO_ONE) return mediaReceipt(agent, url);
    if (selectedVideo(url) !== VIDEO_TWO) throw new Error('Unexpected restart-fixture selection');
    if (waitingUser) return { status: 'blocked', code: 'LOGIN_OR_VERIFICATION_REQUIRED' };
    process.stdout.write(JSON.stringify({ taskId: accepted.downloadTask.id, jobId: accepted.downloadTask.jobId }) + '\n', () => process.exit(0));
    return new Promise(() => {});
  },
});
accepted = await fixture.download({ urls: [videoURL(VIDEO_ONE), videoURL(VIDEO_TWO)], publicOnly: true, mode: 'background' }, { callId: 'restart-crash-fixture' });
admitted.resolve();
if (waitingUser) {
  await fixture.settle(accepted);
  process.stdout.write(JSON.stringify({ taskId: accepted.downloadTask.id, jobId: accepted.downloadTask.jobId }) + '\n', () => process.exit(0));
}
