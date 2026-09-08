// 单个页面身份复用同一次准备；失败不在后台循环重试，显式重试才清理失败缓存。
export class AgentConnection {
  private task:Promise<void>|null=null
  private until=0
  private settled=false
  constructor(private readonly prepare:()=>Promise<void>,private readonly now=Date.now){}
  ensure(){
    if(!this.task||this.now()>=this.until){
      this.until=Infinity;this.settled=false
      this.task=this.prepare().then(()=>{this.settled=true;this.until=this.now()+25*60_000},error=>{this.settled=true;throw error})
    }
    return this.task
  }
  retry(){if(this.task&&!this.settled)return this.task;this.task=null;this.until=0;return this.ensure()}
}
