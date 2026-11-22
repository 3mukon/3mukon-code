import { useContext, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { addCover } from '../../ui/renderer/cover';
import type { MessageImage } from '../shared/events';
import { imageUrl } from '../shared/images';
import { TimelineActionsContext } from './timeline-actions';

// Images in a message, in what a tool call returned or going with the message being written, as
// thumbnails that keep their proportions; small ones in the composer; and the screenshots the app's
// tools took, each a small frame of its top, in a well under a dashed line.
export function Images({
  images,
  small = false,
  shot = false,
}: {
  images: MessageImage[];
  small?: boolean;
  shot?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap gap-1.5">
      {images.map((image, index) => (
        <Thumbnail
          // A message's images never change order.
          key={index}
          image={image}
          label={t('sessions.image.alt', { index: index + 1 })}
          small={small}
          shot={shot}
        />
      ))}
    </div>
  );
}

// One image: a double click, or Return or Space, shows it enlarged; a right click or the menu key
// offers Copy Image and Save Image As….
export function Thumbnail({
  image,
  label,
  small = false,
  shot = false,
}: {
  image: MessageImage;
  label: string;
  small?: boolean;
  shot?: boolean;
}) {
  const actions = useContext(TimelineActionsContext);
  const [enlarged, setEnlarged] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-label={label}
        title={label}
        // A click from the keyboard has no pointer, and enlarges at once.
        onClick={(event) => {
          if (event.detail === 0) setEnlarged(true);
        }}
        onDoubleClick={() => {
          setEnlarged(true);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          actions.imageMenu(image);
        }}
        className={
          shot
            ? 'block shrink-0 overflow-hidden rounded-md border border-dashed border-line paper-well p-1.5'
            : `block overflow-hidden rounded-md border border-line paper-well ${small ? 'shrink-0' : 'max-w-full min-w-0'}`
        }
      >
        <img
          src={imageUrl(image)}
          alt=""
          draggable={false}
          className={
            shot
              ? 'block h-20 w-[198px] rounded-[3px] object-cover object-top'
              : small
                ? 'h-14 w-auto max-w-40 object-cover'
                : 'max-h-64 w-auto max-w-full object-contain'
          }
        />
      </button>
      {enlarged && (
        <Enlarged
          image={image}
          label={label}
          onClose={() => {
            setEnlarged(false);
          }}
        />
      )}
    </>
  );
}

// The image enlarged over the window, as large as fits, until Escape, a click beside it or a double
// click on it; its menu works there too.
function Enlarged({
  image,
  label,
  onClose,
}: {
  image: MessageImage;
  label: string;
  onClose: () => void;
}) {
  const actions = useContext(TimelineActionsContext);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    return addCover('window');
  }, []);
  const close = () => {
    dialog.current?.close();
  };
  return (
    <dialog
      ref={dialog}
      aria-label={label}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
      className="m-auto max-h-none max-w-none bg-transparent p-0 outline-none backdrop:bg-scrim"
    >
      <img
        src={imageUrl(image)}
        alt={label}
        draggable={false}
        onDoubleClick={close}
        onContextMenu={(event) => {
          event.preventDefault();
          actions.imageMenu(image);
        }}
        className="block max-h-[92vh] max-w-[92vw] rounded-md object-contain"
      />
    </dialog>
  );
}
