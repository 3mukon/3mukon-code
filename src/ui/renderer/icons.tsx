import { Plus as LucidePlus, type LucideIcon, type LucideProps } from 'lucide-react';

// The app's icons, from Lucide (ADR-0007). Other modules take icons from here, never from
// lucide-react, so the app keeps one icon set; a new icon is one more line at the end. Icons draw in
// the current text colour and are hidden from VoiceOver, so whatever shows one also names it in words.
function decorative(Icon: LucideIcon) {
  return function DecorativeIcon(props: LucideProps) {
    return <Icon aria-hidden="true" {...props} />;
  };
}

export const Plus = decorative(LucidePlus);
