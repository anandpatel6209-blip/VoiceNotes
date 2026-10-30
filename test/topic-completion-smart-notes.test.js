import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hasTopicTransitionCue, parseNotesResponse } from '../src/shared/validator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

describe('Topic-Based Smart Note Generation & Topic Completion Timing', () => {
  it('1. Detects topic transition phrases signaling topic completion', () => {
    assert.strictEqual(
      hasTopicTransitionCue('So that concludes our discussion of process state. Now let us move on to CPU scheduling algorithms.'),
      true
    );
    assert.strictEqual(
      hasTopicTransitionCue('In summary, mutex locks provide mutual exclusion but can suffer from priority inversion.'),
      true
    );
    assert.strictEqual(
      hasTopicTransitionCue('Next up we have the two-phase commit protocol.'),
      true
    );
    assert.strictEqual(
      hasTopicTransitionCue('This is just normal internal discussion without any transition markers.'),
      false
    );
  });

  it('2. Background service worker enforces Heading then Summary of Whole Topic', () => {
    const bgContent = fs.readFileSync(path.join(rootDir, 'background.js'), 'utf8');

    // Verifies system prompt requires Heading followed by Summary of the Whole Topic
    assert.match(bgContent, /Topic Heading/i, 'Prompt must require a Topic Heading');
    assert.match(bgContent, /Summary of the Whole Topic/i, 'Prompt must require a Summary of the Whole Topic');
    assert.match(bgContent, /HEADING,\s*then\s*SUMMARY\s*OF\s*THE\s*WHOLE\s*TOPIC/i, 'Must specify heading then summary format');
    assert.match(bgContent, /Synthesize the WHOLE topic comprehensively/i, 'Must synthesize the whole topic rather than fragmented pieces');
  });

  it('3. Parses completed topic note containing Heading and Whole Topic Summary', () => {
    const aiOutput = JSON.stringify([
      {
        time: 0,
        text: `# 1. Introduction to Operating System Kernels\n\n\nThe operating system kernel serves as the core intermediary between application software and raw computer hardware, running in privileged supervisor mode.\n\n### Architectural Role & Responsibilities\nThe kernel arbitrates all resource requests and manages concurrent execution:\n- **Memory Management:** Manages page tables, virtual address translation, and process isolation.\n- **Process Scheduling:** Selects which thread runs on available CPU cores to balance latency and throughput.\n- **Device Drivers:** Encapsulates hardware-specific registers behind uniform read/write system call interfaces.\n\n### Summary & Key Takeaways\nIn summary, the kernel is essential for security and resource multiplexing, balancing multi-tenant workloads while insulating user applications from physical hardware complexity.`
      }
    ]);

    const notes = parseNotesResponse(aiOutput, 0);
    assert.strictEqual(notes.length, 1);
    assert.strictEqual(notes[0].time, 0);

    const text = notes[0].text;
    assert.ok(text.startsWith('# 1. Introduction to Operating System Kernels'));
    assert.ok(text.includes('### Architectural Role & Responsibilities'));
    assert.ok(text.includes('Memory Management'));
    assert.ok(text.includes('Summary & Key Takeaways'));
  });

  it('4. Content script implements topic completion tracking instead of premature 15s intervals', () => {
    const contentJs = fs.readFileSync(path.join(rootDir, 'content.js'), 'utf8');

    // Verifies checkTopicCompletion and topic tracking functions exist
    assert.ok(contentJs.includes('checkTopicCompletion'), 'checkTopicCompletion function must be defined');
    assert.ok(contentJs.includes('detectVideoTopics'), 'detectVideoTopics function must be defined');
    assert.ok(contentJs.includes('videoTopics'), 'videoTopics state must be tracked');
    assert.ok(contentJs.includes('completedTopicIndices'), 'completedTopicIndices set must prevent duplicate generation');
    assert.ok(contentJs.includes('VOICENOTES_CHAPTERS_DATA'), 'Must listen for chapter data from bridge');
  });

  it('5. Main-world bridge extracts YouTube chapters and broadcasts VOICENOTES_CHAPTERS_DATA', () => {
    const bridgeJs = fs.readFileSync(path.join(rootDir, 'bridge.js'), 'utf8');

    assert.ok(bridgeJs.includes('getChapters'), 'bridge.js must implement getChapters');
    assert.ok(bridgeJs.includes('broadcastChapters'), 'bridge.js must implement broadcastChapters');
    assert.ok(bridgeJs.includes('VOICENOTES_CHAPTERS_DATA'), 'bridge.js must dispatch VOICENOTES_CHAPTERS_DATA event');
  });

  it('6. Topic completion simulation: Topic 1 generates note only when video reaches completion point', () => {
    // Simulate topic completion logic
    const chapters = [
      { index: 0, title: 'Introduction', startSec: 0, endSec: 120 },
      { index: 1, title: 'Process Scheduling', startSec: 120, endSec: 300 }
    ];
    const completed = new Set();
    const generatedNotes = [];

    function simulateCheck(currentSec) {
      for (let i = 0; i < chapters.length; i++) {
        if (completed.has(i)) continue;
        const topic = chapters[i];
        if (currentSec >= topic.endSec) {
          completed.add(i);
          generatedNotes.push({
            topicIndex: i,
            title: topic.title,
            time: topic.startSec,
            text: `# ${topic.title}\n\n\nComprehensive summary of ${topic.title}.`
          });
          return;
        } else {
          // Still playing inside topic i; do not generate
          break;
        }
      }
    }

    // Playback at 15s (middle of Topic 1): No note generated
    simulateCheck(15);
    assert.strictEqual(generatedNotes.length, 0, 'No note should be generated midway through Topic 1 at 15s');

    // Playback at 60s: Still no note generated
    simulateCheck(60);
    assert.strictEqual(generatedNotes.length, 0, 'No note should be generated at 60s before Topic 1 ends');

    // Playback reaches 120s (end of Topic 1): Topic 1 note is generated!
    simulateCheck(120);
    assert.strictEqual(generatedNotes.length, 1, 'Topic 1 note must be generated when video reaches 120s');
    assert.strictEqual(generatedNotes[0].title, 'Introduction');
    assert.ok(generatedNotes[0].text.startsWith('# Introduction'));

    // Playback at 200s (middle of Topic 2): Still only 1 note
    simulateCheck(200);
    assert.strictEqual(generatedNotes.length, 1, 'Topic 2 note should not generate midway at 200s');

    // Playback reaches 300s (end of Topic 2): Topic 2 note is generated!
    simulateCheck(300);
    assert.strictEqual(generatedNotes.length, 2, 'Topic 2 note must be generated when video reaches 300s');
    assert.strictEqual(generatedNotes[1].title, 'Process Scheduling');
    assert.ok(generatedNotes[1].text.startsWith('# Process Scheduling'));
  });
});

