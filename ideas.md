# ideas to implement
- create 2 mats/refs for each layer and then when playing load the other one fully initialize it and then in 1 go for new timestamp make new one visible and old one invisible. also could preload the png for faster playback
- pressure contours kinda like outlines of highway roads. only for geostrophic winds. i guess ageostrophic might be like "rogue driver" creating disturbances
- trace features like pressure lows/moisture blob backwards - which feature was the river at later date
- calculating how much of particular area is being influenced by pressure centers
- think in terms of imbalanced 3d fluid - what representations naturally arise from this

source of atmospheric river
- for wind parcels, backwards integrate
- for moisture similarly backwards integrate but show according to moisture/precip changes too. like a line but its colored say black to white where white is more moisture this can be more evap or less precip
- for pressure track lowest gph?

- figure out why areas of lower pressure/gph are lower. i guess download all/most levels and look at converg/diverg or temp or some other stuff?

- fix the timestamp based updating stuff you broke. not updating when changing time, when tweaking params doesnt do anything until switch timestamp etc. 
- for the back traj the dots show color based on evap/precip and the more it dominantes the more red/blue. if neither dominates it is grey but how does it show that magnitude of both was big vs neither really happened.

- make curated views rather than raw data layers like something thst shows source, transport, landfall, decay etc that show multiple layers/data together
- for back trajectory layer show ensemble, slightly perturb target lat lon then go backwards 
- lines connecting hourly dots overlaid on dots when they should be under and also seem like they dont start and end at center of a dot