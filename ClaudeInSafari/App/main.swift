import AppKit

// Explicitly wire up AppDelegate without a main nib or storyboard.
// @main / @NSApplicationMain alone do not set the delegate when there
// is no nib; this file replaces them.
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
_ = NSApplicationMain(CommandLine.argc, CommandLine.unsafeArgv)
