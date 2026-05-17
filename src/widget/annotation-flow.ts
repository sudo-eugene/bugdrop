import { createAnnotator, type Tool } from './annotator';
import { createModal, redactionNoteHtml } from './ui';

export function showAnnotationStep(
  root: HTMLElement,
  screenshot: string,
  redactionCount = 0,
  opts?: { redactionUnavailable?: boolean; selectedElementCapture?: boolean }
): Promise<string | 'retake' | 'cancel'> {
  return new Promise(resolve => {
    let redactionNote = '';
    if (opts?.redactionUnavailable) {
      redactionNote = redactionNoteHtml(
        'This browser viewport capture could not apply automatic private-field masks. Review and cover any sensitive areas before sending.'
      );
    } else if (redactionCount > 0) {
      redactionNote = redactionNoteHtml(
        `${redactionCount} private ${redactionCount === 1 ? 'item was' : 'items were'} marked for redaction in this screenshot. Review before sending.`
      );
    }
    const selectedElementNote = opts?.selectedElementCapture
      ? `
        <p class="bd-selected-element-note" style="margin: -4px 0 12px; color: var(--bd-text-secondary); font-size: 13px;">
          Need more surrounding context? Adjust <a href="https://bugdrop.dev/docs/configuration#select-element-screenshots" target="_blank" rel="noopener noreferrer">data-element-context-max-area</a> on the BugDrop script tag.
        </p>
      `
      : '';
    const modal = createModal(
      root,
      'Review Screenshot',
      `
        ${redactionNote}
        <p style="margin: 0 0 12px; color: var(--bd-text-secondary); font-size: 13px;">
          Check that no sensitive information is visible before sending. Cover sensitive areas before submitting. Redactions are baked into the uploaded image.
        </p>
        ${selectedElementNote}
        <div class="bd-tools">
          <button class="bd-tool active" data-tool="draw">✏️ Draw</button>
          <button class="bd-tool" data-tool="arrow">➡️ Arrow</button>
          <button class="bd-tool" data-tool="rect">▢ Rectangle</button>
          <button class="bd-tool" data-tool="redact">Redact</button>
          <button class="bd-tool" data-action="undo">↶ Undo</button>
        </div>
        <div id="annotation-canvas" class="bd-annotation-stage"></div>
        <div class="bd-actions">
          <button class="bd-btn bd-btn-secondary" data-action="retake">Retake</button>
          <button class="bd-btn bd-btn-primary" data-action="done">Submit Feedback</button>
        </div>
      `,
      false,
      'bd-modal--annotator'
    );

    const canvasContainer = modal.querySelector('#annotation-canvas') as HTMLElement;
    const annotator = createAnnotator(canvasContainer, screenshot);

    const toolButtons = modal.querySelectorAll('[data-tool]');
    toolButtons.forEach(btn => {
      btn.addEventListener('click', e => {
        const target = e.currentTarget as HTMLElement;
        const tool = target.dataset.tool;

        if (tool) {
          toolButtons.forEach(b => b.classList.remove('active'));
          target.classList.add('active');
          annotator.setTool(tool as Tool);
        }
      });
    });

    const undoBtn = modal.querySelector('[data-action="undo"]') as HTMLElement | null;
    undoBtn?.addEventListener('click', () => annotator.undo());

    const closeBtn = modal.querySelector('.bd-close') as HTMLElement;
    const retakeBtn = modal.querySelector('[data-action="retake"]') as HTMLElement;
    const doneBtn = modal.querySelector('[data-action="done"]') as HTMLElement;

    closeBtn?.addEventListener('click', () => {
      annotator.destroy();
      modal.remove();
      resolve('cancel');
    });

    retakeBtn?.addEventListener('click', () => {
      annotator.destroy();
      modal.remove();
      resolve('retake');
    });

    doneBtn?.addEventListener('click', () => {
      const annotated = annotator.getImageData();
      annotator.destroy();
      modal.remove();
      resolve(annotated);
    });
  });
}
