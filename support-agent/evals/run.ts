import { pathToFileURL } from "node:url"
import { caseText, loadCases, runLive, runOffline } from "../src/eval.js"

export { caseText, loadCases, runLive, runOffline }

const invoked = process.argv[1]
if (invoked && import.meta.url === pathToFileURL(invoked).href) {
  runLive(process.env).then((code) => {
    process.exit(code)
  })
}
