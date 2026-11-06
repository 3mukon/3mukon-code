import { useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from '../../ui/renderer/icons';
import type { MessageImage } from '../shared/events';
import { MAX_IMAGES } from '../shared/images';
import { readImage, type ImageRefusal } from './image-input';
import { Thumbnail } from './images';

// An image going with the message being written, under an id of its own while it waits.
interface Attachment {
  id: string;
  image: MessageImage;
}

// The images going with the message being written, which the user pastes into the composer or drops
// on it; there is no button to choose files. Pasted text still pastes beside pasted images, and a drop
// of images stays in the composer rather than opening them in panels. Each image is read as it goes
// with a message (readImage); one that cannot go, or one beyond MAX_IMAGES, leaves a notice.
export function useAttachments() {
  const { t } = useTranslation();
  const [attached, setShown] = useState<Attachment[]>([]);
  // The images as the latest change left them, for reads that end after another change.
  const latest = useRef<Attachment[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const setAttached = (next: Attachment[]) => {
    latest.current = next;
    setShown(next);
  };
  const attach = (images: MessageImage[]) =>
    images.map((image) => ({ id: crypto.randomUUID(), image }));

  const add = async (files: File[]) => {
    setNotice(null);
    const read = await Promise.all(files.map(readImage));
    const images = read.flatMap((result) => ('refused' in result ? [] : [result]));
    const refusal = read.find((result): result is { refused: ImageRefusal } => 'refused' in result);
    const room = Math.max(0, MAX_IMAGES - latest.current.length);
    setAttached([...latest.current, ...attach(images.slice(0, room))]);
    if (refusal !== undefined) setNotice(t(`sessions.image.refused.${refusal.refused}`));
    else if (images.length > room)
      setNotice(t('sessions.image.refused.count', { limit: MAX_IMAGES }));
  };

  return {
    attached,
    images: attached.map((attachment) => attachment.image),
    notice,
    dropping,
    remove: (id: string) => {
      setAttached(latest.current.filter((attachment) => attachment.id !== id));
    },
    // Takes the images back, as when a message could not be sent.
    restore: (images: MessageImage[]) => {
      setAttached(attach(images));
    },
    clear: () => {
      setAttached([]);
      setNotice(null);
    },
    onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const files = imageFiles(event.clipboardData.files);
      if (files.length === 0) return;
      if (event.clipboardData.getData('text/plain') === '') event.preventDefault();
      void add(files);
    },
    dropZone: {
      onDragOver: (event: DragEvent<HTMLElement>) => {
        if (!carriesImages(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'copy';
        setDropping(true);
      },
      onDragLeave: (event: DragEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false);
      },
      onDrop: (event: DragEvent<HTMLElement>) => {
        if (!carriesImages(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        setDropping(false);
        void add(imageFiles(event.dataTransfer.files));
      },
    },
  };
}

// The images going with the message, each with a button that takes it out.
export function Attachments({
  attached,
  onRemove,
}: {
  attached: { id: string; image: MessageImage }[];
  onRemove: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <ul aria-label={t('sessions.image.attached')} className="mt-1.5 flex flex-wrap gap-2">
      {attached.map((attachment, index) => {
        const label = t('sessions.image.alt', { index: index + 1 });
        return (
          <li key={attachment.id} className="relative">
            <Thumbnail image={attachment.image} label={label} small />
            <button
              type="button"
              aria-label={t('sessions.image.remove', { image: label })}
              title={t('sessions.image.remove', { image: label })}
              onClick={() => {
                onRemove(attachment.id);
              }}
              className="absolute -top-1.5 -right-1.5 grid size-4 place-items-center rounded-full border border-line paper text-faint hover:text-ink"
            >
              <X className="size-2.5" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function imageFiles(files: FileList): File[] {
  return [...files].filter((file) => file.type.startsWith('image/'));
}

// Whether a drag brings image files, as one from the Finder or a screenshot's thumbnail does.
function carriesImages(transfer: DataTransfer): boolean {
  return [...transfer.items].some((item) => item.kind === 'file' && item.type.startsWith('image/'));
}
