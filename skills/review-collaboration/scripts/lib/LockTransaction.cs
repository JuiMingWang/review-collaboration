using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Security.Cryptography;
using System.Collections.Generic;
using System.Web.Script.Serialization;

// Short OS mutex around one lock-file mutation. No model calls or daemon.
public static class LockTransaction {
  static string NativePath(string path) { return "\\\\?\\"+path; }
  static string Text(Dictionary<string,object> d,string k) { object v; return d.TryGetValue(k,out v)&&v!=null?Convert.ToString(v):null; }
  static void Ordinary(string path) {
    for(string p=path;p!=null;p=Path.GetDirectoryName(p)) {
      string native=NativePath(p);
      if((File.Exists(native)||Directory.Exists(native))&&(File.GetAttributes(native)&FileAttributes.ReparsePoint)!=0) throw new IOException("reparse-lock-path");
    }
  }
  public static int Main() {
    AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling",false);
    AppContext.SetSwitch("Switch.System.IO.BlockLongPaths",false);
    Console.InputEncoding=new UTF8Encoding(false);Console.OutputEncoding=new UTF8Encoding(false);
    Mutex mutex=null;bool held=false;
    try {
      var json=new JavaScriptSerializer();var req=json.Deserialize<Dictionary<string,object>>(Console.In.ReadToEnd());
      string operation=Text(req,"operation"),path=Path.GetFullPath(Text(req,"path"));
      if((operation!="create"&&operation!="delete")||path.Length<3||path[1]!=':'||path[2]!='\\'||!path.EndsWith(".lock",StringComparison.Ordinal))throw new IOException("invalid-lock-request");
      Ordinary(path);
      string digest;using(var sha=SHA256.Create())digest=BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(path.ToLowerInvariant()))).Replace("-","");
      mutex=new Mutex(false,"Local\\ReviewMail_"+digest.ToLowerInvariant());
      try{held=mutex.WaitOne(5000);}catch(AbandonedMutexException){held=true;}
      if(!held)throw new IOException("lock-mutex-timeout");
      // Test-only seam; never accepted by the public dispatcher.
      int hold=req.ContainsKey("test_hold_ms")?Convert.ToInt32(req["test_hold_ms"]):0;
      if(hold<0||hold>5000)throw new IOException("invalid-test-hold");
      string ready=Text(req,"test_ready_file");if(ready!=null)File.WriteAllText(NativePath(ready),System.Diagnostics.Process.GetCurrentProcess().Id.ToString());
      if(hold>0)Thread.Sleep(hold);
      Ordinary(path);
      string nativePath=NativePath(path);
      bool present=File.Exists(nativePath);string nonce=null;
      if(present){try{nonce=Text(json.Deserialize<Dictionary<string,object>>(File.ReadAllText(nativePath,Encoding.UTF8)),"owner_nonce");}catch{}}
      string result="absent";
      if(operation=="create"){
        if(present)result="occupied";
        else{
          string temp=path+"."+Guid.NewGuid().ToString("N")+".tmp";
          byte[] bytes=Encoding.UTF8.GetBytes(json.Serialize(req["owner"]));
          using(var stream=new FileStream(NativePath(temp),FileMode.CreateNew,FileAccess.Write,FileShare.None)){stream.Write(bytes,0,bytes.Length);stream.Flush(true);}
          File.Move(NativePath(temp),nativePath);result="created";
        }
      }else if(present){
        if(nonce==null)result="unreadable";
        else if(nonce!=Text(req,"expected_nonce"))result="changed";
        else{File.Delete(nativePath);result="deleted";}
      }
      Console.WriteLine(json.Serialize(new {schema_version=1,result=result,observed_nonce=nonce}));return 0;
    }catch(Exception e){Console.Error.WriteLine("lock-transaction-failed:"+e.GetType().Name);return 1;}
    finally{if(held)mutex.ReleaseMutex();if(mutex!=null)mutex.Dispose();}
  }
}
