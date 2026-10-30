import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanTranscriptNoise,
  isMeaningfulEducationalTranscript,
  parseNotesResponse,
  validateNote
} from '../src/shared/validator.js';
import fs from 'node:fs';
import path from 'node:path';

describe('Feature 1: Smart AI Notes Generation & Formatting', () => {
  const contentJs = fs.readFileSync(path.join(process.cwd(), 'content.js'), 'utf-8');
  const backgroundJs = fs.readFileSync(path.join(process.cwd(), 'background.js'), 'utf-8');
  const panelCss = fs.readFileSync(path.join(process.cwd(), 'panel.css'), 'utf-8');

  it('1. Filters out music, applause, and meaningless fragments', () => {
    assert.equal(cleanTranscriptNoise('[Music] [Applause]  hello  [Cheering]'), 'hello');
    assert.equal(cleanTranscriptNoise('♪ background melody ♫'), 'background melody');

    // Non-meaningful text (< 15 characters or pure noise)
    assert.equal(isMeaningfulEducationalTranscript('[Music] [Applause]'), false);
    assert.equal(isMeaningfulEducationalTranscript('uh uh umm'), false);
    assert.equal(isMeaningfulEducationalTranscript('♪♪♪'), false);

    // Meaningful educational speech
    assert.equal(
      isMeaningfulEducationalTranscript('Operating systems coordinate memory management and thread scheduling.'),
      true
    );
  });

  it('2. Background worker system prompt enforces smart educational note structure', () => {
    // Main Topic Heading
    assert.match(backgroundJs, /# \[Main Topic Heading\]/);
    // Vertical spacing
    assert.match(backgroundJs, /two blank lines of vertical spacing directly below/i);
    // Introduction
    assert.match(backgroundJs, /introductory overview/i);
    // Concepts with subheadings
    assert.match(backgroundJs, /### \[Subheading\]/);
    // Explanations and bullet points
    assert.match(backgroundJs, /concise bullet points/i);
    // Code snippets
    assert.match(backgroundJs, /fenced code blocks/i);
    // Final summary
    assert.match(backgroundJs, /Key Takeaways & Summary/i);
    // Noise / ad filtering
    assert.match(backgroundJs, /isMeaningfulEducationalTranscript/);
    // Incremental continuity
    assert.match(backgroundJs, /do NOT re-generate the '# \[Main Topic Heading\]'/i);
  });

  it('3. Parses multi-line structured smart notes with code snippets and headings without truncation', () => {
    const rawAiOutput = JSON.stringify([
      {
        time: 0,
        text: `# Operating System Architecture\n\nAn operating system acts as the intermediary between computer hardware and user applications.\n\n### The Kernel Core\nThe kernel executes in supervisor mode with high privileges:\n- **Process Scheduling**: Allocating CPU execution time.\n- **Virtual Memory**: Address space isolation.\n\n\`\`\`c\npid_t pid = fork();\nif (pid == 0) {\n    printf("Child process\\n");\n}\n\`\`\``
      },
      {
        time: 45,
        text: `### Memory Management Subsystem\n\nVirtual memory uses paging to map logical addresses to physical RAM frames:\n- **TLB**: Translation Lookaside Buffer caches page table entries.\n- **Page Fault**: Occurs when a referenced page is not resident in physical RAM.\n\n### Key Takeaways & Summary\nUnderstanding the boundary between user space and kernel space is fundamental to systems engineering.`
      }
    ]);

    const parsed = parseNotesResponse(rawAiOutput, 0);
    assert.equal(parsed.length, 2);
    assert.match(parsed[0].text, /# Operating System Architecture/);
    assert.match(parsed[0].text, /```c/);
    assert.match(parsed[1].text, /### Key Takeaways & Summary/);

    // Ensure validateNote supports detailed rich text up to 5000 characters
    const validated = validateNote(parsed[0]);
    assert.ok(validated.text.length > 200);
    assert.equal(validated.source, 'ai');
  });

  it('4. Content script renders safe Markdown elements (headings, code blocks, lists, paragraphs)', () => {
    // Assert renderSafeMarkdown and renderInlineMarkdown exist
    assert.match(contentJs, /function renderSafeMarkdown\(/);
    assert.match(contentJs, /function renderInlineMarkdown\(/);

    // Assert main heading uses .vn-notepad-heading-main
    assert.match(contentJs, /vn-notepad-heading-main/);
    // Assert subheadings use .vn-notepad-subheading
    assert.match(contentJs, /vn-notepad-subheading/);
    // Assert code block uses .vn-notepad-code-block
    assert.match(contentJs, /vn-notepad-code-block/);
    // Assert bullet list uses .vn-notepad-bullet-list
    assert.match(contentJs, /vn-notepad-bullet-list/);
  });

  it('5. CSS mandates approximately two lines of vertical spacing below the main heading', () => {
    // Matches margin-bottom: 2em (~2 lines)
    assert.match(
      panelCss,
      /\.vn-notepad-heading-main\s*\{[^}]*margin-bottom:\s*2em;/,
      'Main topic heading must have ~2 lines (2em) vertical spacing below'
    );
    // Code block styling
    assert.match(panelCss, /\.vn-notepad-code-block/);
    // Inline code styling
    assert.match(panelCss, /\.vn-notepad-inline-code/);
  });
});

