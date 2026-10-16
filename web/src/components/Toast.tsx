export type ToastState = {
  tone: "info" | "error";
  text: string;
};

type ToastProps = {
  toast: ToastState;
  onDismiss(): void;
};

export function Toast({ toast, onDismiss }: ToastProps) {
  return (
    <div className="toast" data-tone={toast.tone} role="status">
      <span>{toast.text}</span>
      <button
        className="text-button"
        type="button"
        aria-label="Dismiss notification"
        onClick={onDismiss}
      >
        dismiss
      </button>
    </div>
  );
}
