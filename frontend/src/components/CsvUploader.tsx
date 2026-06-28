import { useRef, useState } from "react";
import { Upload, FileText, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  onFile: (file: File) => void;
  loading?: boolean;
}

export function CsvUploader({ onFile, loading }: Props) {
  const [dragging, setDragging] = useState(false);
  const [filename, setFilename] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function handle(file: File) {
    if (!file.name.endsWith(".csv")) {
      setError("File must be a .csv");
      return;
    }
    setError(null);
    setFilename(file.name);
    onFile(file);
  }

  return (
    <div className="space-y-2">
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files[0];
          if (f) handle(f);
        }}
        onClick={() => inputRef.current?.click()}
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-8 transition-colors",
          dragging
            ? "border-blue-400 bg-blue-50"
            : "border-gray-300 bg-gray-50 hover:border-blue-300 hover:bg-blue-50/50"
        )}
      >
        <Upload className="h-8 w-8 text-gray-400" />
        <div className="text-center">
          <p className="text-sm font-medium text-gray-700">
            {loading ? "Uploading…" : "Drop CSV here or click to browse"}
          </p>
          <p className="text-xs text-gray-400 mt-1">Only .csv files accepted</p>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".csv"
          className="sr-only"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handle(f); }}
        />
      </div>

      {filename && !error && (
        <div className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-700">
          <FileText className="h-4 w-4 shrink-0" />
          <span className="truncate">{filename}</span>
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}
    </div>
  );
}
