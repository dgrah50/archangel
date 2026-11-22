# Go concurrency

Look for:
- goroutines that never exit when their context is cancelled or their channel is closed
- data races on maps, slices, or struct fields shared between goroutines without a lock
- sends on a closed channel, or double close
- `sync.WaitGroup.Add` called inside the goroutine it waits for

The reproduction should run under `go test -race` and fail on `main` today.
