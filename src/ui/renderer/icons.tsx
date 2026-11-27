import {
  Archive as LucideArchive,
  ArchiveRestore as LucideArchiveRestore,
  Brain as LucideBrain,
  CaseSensitive as LucideCaseSensitive,
  Check as LucideCheck,
  ChevronDown as LucideChevronDown,
  ChevronLeft as LucideChevronLeft,
  ChevronRight as LucideChevronRight,
  ChevronUp as LucideChevronUp,
  CircleAlert as LucideCircleAlert,
  CircleQuestionMark as LucideCircleQuestionMark,
  Copy as LucideCopy,
  FileText as LucideFileText,
  FolderInput as LucideFolderInput,
  Gauge as LucideGauge,
  Globe as LucideGlobe,
  Inbox as LucideInbox,
  Lock as LucideLock,
  Monitor as LucideMonitor,
  MousePointer2 as LucideMousePointer2,
  PanelLeft as LucidePanelLeft,
  PanelRight as LucidePanelRight,
  Pencil as LucidePencil,
  Plus as LucidePlus,
  Regex as LucideRegex,
  Replace as LucideReplace,
  ReplaceAll as LucideReplaceAll,
  RotateCw as LucideRotateCw,
  Search as LucideSearch,
  Settings as LucideSettings,
  ShieldCheck as LucideShieldCheck,
  ShieldOff as LucideShieldOff,
  Terminal as LucideTerminal,
  TextSelect as LucideTextSelect,
  ToggleRight as LucideToggleRight,
  Trash as LucideTrash,
  WholeWord as LucideWholeWord,
  Wrench as LucideWrench,
  X as LucideX,
  CirclePause as LucideCirclePause,
  CircleStop as LucideCircleStop,
  Cpu as LucideCpu,
  GitBranchPlus as LucideGitBranchPlus,
  LayoutPanelLeft as LucideLayoutPanelLeft,
  ListChecks as LucideListChecks,
  ListTree as LucideListTree,
  MailOpen as LucideMailOpen,
  PanelRightClose as LucidePanelRightClose,
  PanelRightOpen as LucidePanelRightOpen,
  PanelsTopLeft as LucidePanelsTopLeft,
  Plug as LucidePlug,
  RefreshCw as LucideRefreshCw,
  Send as LucideSend,
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
export const Gauge = decorative(LucideGauge);
export const ChevronUp = decorative(LucideChevronUp);
export const CaseSensitive = decorative(LucideCaseSensitive);
export const WholeWord = decorative(LucideWholeWord);
export const Regex = decorative(LucideRegex);
export const Replace = decorative(LucideReplace);
export const ReplaceAll = decorative(LucideReplaceAll);
export const TextSelect = decorative(LucideTextSelect);
export const RotateCw = decorative(LucideRotateCw);
export const ChevronLeft = decorative(LucideChevronLeft);
export const CircleAlert = decorative(LucideCircleAlert);
export const Lock = decorative(LucideLock);
export const Monitor = decorative(LucideMonitor);
export const Pointer = decorative(LucideMousePointer2);
export const PanelLeft = decorative(LucidePanelLeft);
export const PanelRight = decorative(LucidePanelRight);
export const Inbox = decorative(LucideInbox);
export const CirclePause = decorative(LucideCirclePause);
export const CircleStop = decorative(LucideCircleStop);
export const Cpu = decorative(LucideCpu);
export const GitBranchPlus = decorative(LucideGitBranchPlus);
export const LayoutPanelLeft = decorative(LucideLayoutPanelLeft);
export const ListChecks = decorative(LucideListChecks);
export const ListTree = decorative(LucideListTree);
export const MailOpen = decorative(LucideMailOpen);
export const PanelRightClose = decorative(LucidePanelRightClose);
export const PanelRightOpen = decorative(LucidePanelRightOpen);
export const PanelsTopLeft = decorative(LucidePanelsTopLeft);
export const Plug = decorative(LucidePlug);
export const RefreshCw = decorative(LucideRefreshCw);
export const Send = decorative(LucideSend);
