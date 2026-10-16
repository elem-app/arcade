type FooterProps = {
  connected: boolean;
  workingRoot: string;
  onChangeRoot(): void;
};

export function Footer({ connected, workingRoot, onChangeRoot }: FooterProps) {
  return (
    <footer className="panel footer">
      <span className="status" data-connected={connected}>
        {connected ? "Connected" : "Offline"}
      </span>
      <span className="sep">·</span>
      <span>principal: local web user</span>
      <span className="sep">·</span>
      <span className="footer-root">
        working root: {workingRoot || "not set"}{" "}
        <button className="text-button" type="button" onClick={onChangeRoot}>
          change
        </button>
      </span>
      <span className="grow" />
      <span>polling 2s</span>
    </footer>
  );
}
