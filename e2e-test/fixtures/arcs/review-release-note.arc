"arc";

function ReviewReleaseNote() {
  this.trigger = () => {
    return true;
  };
  this.hostParams = {
    workerRole: "reviewer",
  };
  $instruct(`Review the draft response before it is treated as approved.`);
}
