Motor files at the edges of what OpenRocket reads, for `orcloud.bridge.MotorFileCheck` (run by
`scripts/test.sh`), which loads each one with OpenRocket's own motor readers after the session's tidying
(`OrDoc.tidyMotorFile`). `server/test/motors.test.js` then checks that the site's upload check
(`server/src/motors.js`) accepts exactly the files OpenRocket loads, and tidies them the same way.
Files named `strict-*` are ones OpenRocket would load but the upload refuses as nonsense.
