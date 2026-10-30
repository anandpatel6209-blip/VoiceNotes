/**
 * VoiceNotes - Markdown Export Formatter
 * Generates formatted Markdown with timestamp jump links, video metadata,
 * and clear distinction between AI-generated and user-authored notes.
 */

import { formatTime, sanitizeFilename } from './validator.js';

export function formatNotesToMarkdown({ title, videoId, videoUrl, notes = [], exportDate = new Date() }) {
  const safeTitle = title ? title.trim() : 'Video Notes';
  const formattedDate = exportDate.toISOString().split('T')[0];

  // Base YouTube URL for timestamp jumping
  const baseUrl = videoId
    ? `https://www.youtube.com/watch?v=${videoId}`
    : (videoUrl || '');

  const sortedNotes = [...notes].sort((a, b) => a.time - b.time);

  const lines = [];
  lines.push(`# ${safeTitle}`);
  lines.push('');
  lines.push(`- **Exported:** ${formattedDate}`);
  if (baseUrl) {
    lines.push(`- **Video URL:** [Watch Video](${baseUrl})`);
  }
  lines.push(`- **Total Notes:** ${sortedNotes.length}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Notes');
  lines.push('');

  if (sortedNotes.length === 0) {
    lines.push('_No notes recorded for this video._');
    return lines.join('\n');
  }

  for (const note of sortedNotes) {
    const timeFormatted = formatTime(note.time);
    const jumpLink = baseUrl
      ? `[${timeFormatted}](${baseUrl}&t=${note.time}s)`
      : `\`${timeFormatted}\``;

    const cleanText = (note.text || '').trim();

    if (note.source === 'user') {
      // User-authored note with distinct block/badge
      lines.push(`- ${jumpLink} **[YOU]** ${cleanText}`);
    } else {
      // AI note
      lines.push(`- ${jumpLink} ${cleanText}`);
    }
  }

  lines.push('');
  lines.push('---');
  lines.push('_Generated with [VoiceNotes](https://github.com/anandpatel6209-blip/VoiceNotes)_');

  return lines.join('\n');
}

export function generateExportFilename(title, exportDate = new Date()) {
  const formattedDate = exportDate.toISOString().split('T')[0];
  const safeTitle = sanitizeFilename(title, 'VideoNotes');
  return `VoiceNotes_${safeTitle}_${formattedDate}.md`;
}
