# reGhost

After it was pointed out that substack is happy to host and monetize [nazi content](https://www.theguardian.com/media/2026/feb/07/revealed-how-substack-makes-money-from-hosting-nazi-newsletters), I got finally motivated to seek an alternative.

And since I'm a cloud architect, this will become a little project of creating a VM-based instance of [Ghost](https://ghost.org/) and optimizing it cost-wise as much as possible all the while improving its architecture. Yak shaving? Maybe, but that's not the point.

Common for all phases is that the blog should be accessible via https://the-well-architected-cloud.com/blog

## Phase 1. VM

A naive single-VM implementation to establish a cost baseline.

## Phase 2. Containers

Containerize the application (aka improve resilience) without increasing costs (ideally decreasing).

## Phase 3. Magic

Make the application fully cloud-native, aka only running parts pf the application that are needed at the moment and only for as long as they are needed.

