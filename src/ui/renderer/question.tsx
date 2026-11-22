import { useId, useLayoutEffect, useRef } from 'react';
import { addCover } from './cover';
import type { Question } from '../shared/prompts';

interface QuestionDialogProps {
  question: Question;
  // Called once, with the id of the answer given.
  onAnswer: (id: string) => void;
}

// A question over the window, as macOS hangs a sheet from its title bar but drawn as a sheet of the
// window's paper under a dashed line: the message, its detail, and the answers in a row, the first at
// the right and any beyond the second apart at the left, as macOS lays out a sheet's buttons; the
// default answer is drawn in ink and has the keyboard focus, so that Return gives it, and Escape gives
// the cancel answer. Nothing else in the window can be reached until it is answered, and the focus
// then returns where it was. VoiceOver hears it as an alert, with its message and detail.
export function QuestionDialog({ question, onAnswer }: QuestionDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const answered = useRef(false);
  const active = useRef(false);
  const message = useId();
  const detail = useId();

  const answer = (id: string) => {
    if (answered.current) return;
    answered.current = true;
    onAnswer(id);
  };

  useLayoutEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    active.current = true;
    element.showModal();
    const uncover = addCover('window');
    element.querySelector<HTMLElement>('[data-default]')?.focus();
    return () => {
      active.current = false;
      uncover();
      element.close();
    };
  }, []);

  return (
    <dialog
      ref={dialog}
      role="alertdialog"
      aria-labelledby={message}
      aria-describedby={detail}
      // Escape asks the dialog to close, which gives the cancel answer; where it closes regardless, it
      // still does.
      onCancel={(event) => {
        event.preventDefault();
        answer(question.cancelId);
      }}
      onClose={(event) => {
        // StrictMode closes and reopens the dialog while replaying its effect. The browser queues
        // close, so cleanup's event can arrive after it is open again; that is not a user answer.
        if (!active.current || event.currentTarget.open) return;
        answer(question.cancelId);
      }}
      className="mx-auto mt-12 w-90 max-w-[calc(100vw-32px)] rounded-md border border-dashed border-menu-line paper p-4 text-ink backdrop:bg-scrim/40"
    >
      <p id={message} className="font-bold">
        {question.message}
      </p>
      <p id={detail} className="mt-1 text-[12px] text-muted">
        {question.detail}
      </p>
      <div className="mt-4 flex flex-row-reverse gap-2">
        {question.answers.map((option, index) => {
          const primary = option.id === question.defaultId;
          return (
            <button
              key={option.id}
              type="button"
              {...(primary ? { 'data-default': '' } : {})}
              onClick={() => {
                answer(option.id);
              }}
              className={`rounded-md border px-2.5 py-0.5 text-[12px] ${index >= 2 ? 'mr-auto' : ''} ${primary ? 'border-ink bg-ink text-frame hover:opacity-90' : 'border-line text-ink hover:bg-hover'}`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </dialog>
  );
}
