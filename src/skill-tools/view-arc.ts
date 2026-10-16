/** One Arc script to show; its path names its source, as in the viewer. */
export type ViewedArcFile = {
  path: string;
  text: string;
};

/**
 * Returns a copy of the Arc viewer page with `files` embedded, so the page
 * opens on them. The viewer reads the JSON array from the script element with
 * id `arc-files`; every `<` is escaped so no script text can close the element.
 */
export function embedArcFiles(
  viewerHtml: string,
  files: readonly ViewedArcFile[],
): string {
  const json = JSON.stringify(files).replaceAll("<", "\\u003c");
  const element = `<script type="application/json" id="arc-files">${json}</script>\n`;
  const at = viewerHtml.lastIndexOf("</body>");
  if (at === -1) throw new Error("The viewer page has no </body> tag.");
  return viewerHtml.slice(0, at) + element + viewerHtml.slice(at);
}
