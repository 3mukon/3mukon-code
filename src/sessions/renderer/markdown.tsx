import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Markdown as RenderedMarkdown } from '../../ui/renderer/markdown';
import type { MessageImage } from '../shared/events';
import { Thumbnail } from './images';

// An image the message carries in a data URL.
const dataImage = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/;

// An image in the message: one it carries shows as the timeline's other images do; one elsewhere, as
// on the web, is not fetched and shows as a link to it.
function MarkdownImage({ src, alt }: { src: string; alt: string }) {
  const { t } = useTranslation();
  const [, mediaType, data] = dataImage.exec(src) ?? [];
  if (mediaType !== undefined && data !== undefined) {
    const image: MessageImage = { mediaType, data };
    return (
      <Thumbnail image={image} label={alt === '' ? t('sessions.image.alt', { index: 1 }) : alt} />
    );
  }
  return (
    <a href={src} className="text-accent underline underline-offset-2">
      {alt === '' ? src : alt}
    </a>
  );
}

const messageImage = (src: string, alt: string) => <MarkdownImage src={src} alt={alt} />;

// A message as Markdown, with the ui module's renderer (ADR-0010, ADR-0018), in the activity's small
// monospaced type; the images it carries show as thumbnails. It is text from the agent or the user.
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return <RenderedMarkdown text={text} image={messageImage} />;
});
