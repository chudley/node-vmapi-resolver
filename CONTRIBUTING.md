# Contributing to vmapi-resolver

This repository uses [cr.joyent.us](https://cr.joyent.us) (Gerrit) for new
changes.  Anyone can submit changes.  To get started, see the [cr.joyent.us user
guide](https://github.com/joyent/joyent-gerrit/blob/master/docs/user/README.md).
This repo does not use GitHub pull requests.

You must submit a GitHub issue before submitting a change for code review.

See the [Joyent Engineering
Guidelines](https://github.com/joyent/eng/blob/master/docs/index.md) for general
best practices expected in this repository.

Contributions should be "make prepush" clean.  The "prepush" target runs the
"check" target, which requires these separate tools:

* https://github.com/davepacheco/jsstyle
* https://github.com/davepacheco/javascriptlint
