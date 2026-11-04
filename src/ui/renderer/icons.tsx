import {
  Archive as LucideArchive,
  ArchiveRestore as LucideArchiveRestore,
  Brain as LucideBrain,
  Check as LucideCheck,
  ChevronDown as LucideChevronDown,
  ChevronRight as LucideChevronRight,
  CircleQuestionMark as LucideCircleQuestionMark,
  Copy as LucideCopy,
  FileText as LucideFileText,
  FolderInput as LucideFolderInput,
  Globe as LucideGlobe,
  Pencil as LucidePencil,
  Plus as LucidePlus,
  Search as LucideSearch,
  Settings as LucideSettings,
  ShieldCheck as LucideShieldCheck,
  ShieldOff as LucideShieldOff,
  Terminal as LucideTerminal,
  ToggleRight as LucideToggleRight,
  Trash as LucideTrash,
  Wrench as LucideWrench,
  X as LucideX,
  type LucideIcon,
  type LucideProps,
} from 'lucide-react';

// The app's icons, from Lucide (ADR-0007). Other modules take icons from here, never from
// lucide-react, so the app keeps one icon set; a new icon is one more line at the end. Icons draw in
// the current text colour and are hidden from VoiceOver, so whatever shows one also names it in words.
function decorative(Icon: LucideIcon) {
  return function DecorativeIcon(props: LucideProps) {
    return <Icon aria-hidden="true" {...props} />;
  };
}

export const Plus = decorative(LucidePlus);
export const ChevronRight = decorative(LucideChevronRight);
export const ChevronDown = decorative(LucideChevronDown);
export const ShieldOff = decorative(LucideShieldOff);
export const X = decorative(LucideX);
export const FileText = decorative(LucideFileText);
export const Pencil = decorative(LucidePencil);
export const Trash = decorative(LucideTrash);
export const FolderInput = decorative(LucideFolderInput);
export const Search = decorative(LucideSearch);
export const Terminal = decorative(LucideTerminal);
export const Brain = decorative(LucideBrain);
export const Globe = decorative(LucideGlobe);
export const ToggleRight = decorative(LucideToggleRight);
export const Wrench = decorative(LucideWrench);
export const Copy = decorative(LucideCopy);
export const Check = decorative(LucideCheck);
export const ShieldCheck = decorative(LucideShieldCheck);
export const CircleQuestionMark = decorative(LucideCircleQuestionMark);
export const Archive = decorative(LucideArchive);
export const ArchiveRestore = decorative(LucideArchiveRestore);
export const Gear = decorative(LucideSettings);
