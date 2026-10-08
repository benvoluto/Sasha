// The app's icon set: Phosphor, exposed under the names the codebase already
// uses.
//
// Every component imports its icons from here rather than from the icon package
// directly. That keeps the choice of icon library in one file — this migration
// off lucide was a single table edit rather than 29 scattered ones — and it
// keeps the naming consistent while the two libraries disagree about what a
// thing is called (lucide's Search is Phosphor's MagnifyingGlass).
//
// Sizing: Phosphor renders at 1em, so the existing `h-4 w-4` Tailwind classes
// keep working unchanged. Stroke weight is set once, app-wide, by the
// IconContext provider in app/providers.tsx — Phosphor's default "regular" is
// noticeably lighter than lucide's 2px stroke, and "bold" is the closest match.

export { IconContext } from "@phosphor-icons/react";

export {
  // status + feedback
  WarningCircle as AlertCircle,
  Warning as AlertTriangle,
  CheckCircle as CheckCircle2,
  CheckCircle as CircleCheck,
  Check,
  Check as CheckIcon,
  XCircle,
  XCircle as CircleX,
  Question as HelpCircle,
  Info,
  CircleNotch as Loader2,
  Sparkle as Sparkles,
  ShieldCheck,

  // navigation + chrome
  ArrowLeft,
  ArrowLeft as ArrowLeftIcon,
  ArrowRight,
  ArrowsDownUp as ArrowUpDown,
  CaretDown as ChevronDown,
  CaretDown as ChevronDownIcon,
  CaretLeft as ChevronLeft,
  CaretLeft as ChevronLeftIcon,
  CaretRight as ChevronRight,
  CaretRight as ChevronRightIcon,
  CaretUp as ChevronUpIcon,
  DotsThree as MoreHorizontalIcon,
  DotsSixVertical as GripVerticalIcon,
  X,
  X as XIcon,
  SignOut as LogOut,
  Power as SquarePowerIcon,
  Moon,
  Sun,

  // cases, documents, reports
  Archive,
  ArrowCounterClockwise as ArrowRestore,
  ArrowCounterClockwise as ArchiveRestore,
  Stack as Boxes,
  BookOpen,
  CalendarBlank as Calendar,
  ChartBar as BarChart3,
  ClipboardText as ClipboardList,
  File,
  FileText,
  Notepad as FileBarChart2,
  FolderOpen,
  SquaresFour as LayoutTemplate,

  // actions
  ArrowsOut as Maximize,
  ArrowsIn as Minimize,
  CloudArrowUp as CloudUpload,
  CloudArrowUp as UploadCloud,
  DownloadSimple as Download,
  Eye,
  EyeSlash as EyeOff,
  Funnel as ListFilter,
  MagnifyingGlass as Search,
  MagnifyingGlass as SearchIcon,
  MinusCircle as CircleMinus,
  PaperPlaneTilt as Send,
  PencilSimple as Pencil,
  PencilSimpleLine as PencilLine,
  Plus,
  PlusCircle as CirclePlus,
  ArrowClockwise as RefreshCw,
  Trash as Trash2,

  // list density toggle
  Rows as Rows3,
  ListDashes as LayoutList,

  // editor toolbar
  TextAlignCenter as AlignCenter,
  TextAlignLeft as AlignLeft,
  TextAlignRight as AlignRight,
  TextB as Bold,
  TextItalic as Italic,
  TextStrikethrough as Strikethrough,
  TextUnderline as Underline,
  TextHOne as Heading2,
  ListBullets as List,
  ListNumbers as ListOrdered,
  Link as Link2,
  Table,
  ArrowUUpLeft as Undo2,
  ArrowUUpRight as Redo2,
  Highlighter,
  Code,
  TextT,
  Quotes,
  Minus,
  Eraser,
  CaretUpDown,
  TextAlignJustify as AlignJustify,

  // document screen
  ShareFat as Share,
  Sparkle as SparkleIcon,
  ClipboardText as OutlineIcon,
  ListChecks as SourcesIcon,
  Copy,
  Files as DocsIcon,

  // sources library
  Books as LibraryIcon,
  Folder,
  FolderPlus,
  Globe,
  Note as NoteIcon,
  ArrowSquareOut as ExternalLink,
  LinkBreak as Unlink,
  DotsThreeVertical as MoreVertical,

  // determination workflow
  Play,
  FloppyDisk as Save,
  TreeStructure as Workflow,
  Clock,
  Hourglass,
  PauseCircle,
  // node types on the canvas
  ArrowsSplit,
  Files,
  GitFork,
  HandPalm,
  IdentificationCard,
  ListChecks,
  Package,
  Scales,
  Tag,
  UserCheck,

  // primitives used by the shadcn ui/ components
  Circle as CircleIcon,
} from "@phosphor-icons/react";
